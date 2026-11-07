/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { mockServer } from '@nocobase/test';
import { randomId } from '../security';
import { StartupGuardianDatabase } from '../database-adapter';
import { startupGuardianCli } from '../cli';
import { createDefaultPolicy } from '../policy';
import type { ClusterRecoveryAuthority, StartupIncident } from '../contracts';

const databaseHost = '127.0.0.1';
const databasePort = '55462';
const databaseName = 'guardian_ha_test';
const databaseUser = 'guardian_ha_test';
const databasePassword = 'guardian_ha_test_only';
const prefix = `gha_${randomId().replaceAll('-', '').slice(0, 10)}_`;
const appId = 'ha-main';
const deploymentId = `proof-${randomId().slice(0, 8)}`;

describe('Startup Guardian PostgreSQL cluster control protocol', () => {
  const envKeys = [
    'DB_DIALECT',
    'DB_HOST',
    'DB_PORT',
    'DB_DATABASE',
    'DB_USER',
    'DB_PASSWORD',
    'DB_SCHEMA',
    'DB_TABLE_PREFIX',
  ] as const;
  const previousEnvironment = new Map(envKeys.map((key) => [key, process.env[key]]));
  let app: ReturnType<typeof mockServer>;

  beforeAll(async () => {
    process.env.DB_DIALECT = 'postgres';
    process.env.DB_HOST = databaseHost;
    process.env.DB_PORT = databasePort;
    process.env.DB_DATABASE = databaseName;
    process.env.DB_USER = databaseUser;
    process.env.DB_PASSWORD = databasePassword;
    process.env.DB_SCHEMA = 'public';
    process.env.DB_TABLE_PREFIX = prefix;
    app = mockServer({
      name: appId,
      database: {
        dialect: 'postgres',
        host: databaseHost,
        port: Number(databasePort),
        database: databaseName,
        username: databaseUser,
        password: databasePassword,
        schema: 'public',
        tablePrefix: prefix,
        logging: false,
      },
      plugins: [],
    });
    await app.db.import({
      directory: `${process.cwd()}/packages/plugins/plugin-startup-guardian/src/server/collections`,
    });
    await app.db.sync();
    await app.pm.repository.create({
      values: {
        name: 'faulty-plugin',
        packageName: 'plugin-faulty-plugin',
        version: '1.0.0',
        enabled: true,
        installed: true,
        builtIn: false,
        options: { keep: 'original' },
      },
    });
  });

  afterAll(async () => {
    await app?.destroy();
    for (const key of envKeys) {
      const value = previousEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    await app.pm.repository.update({
      filter: { name: 'faulty-plugin', packageName: 'plugin-faulty-plugin' },
      values: { enabled: true, installed: true, builtIn: false, options: { keep: 'original' } },
    });
  });

  it('requires explicit enrollment and fences stale owners before a shared quarantine', async () => {
    const database = await StartupGuardianDatabase.connectFromEnvironment();
    const policy = createApprovedPolicy();
    try {
      await expect(
        database.registerClusterMember(
          { appId, deploymentId },
          {
            nodeId: 'main',
            bootId: 'boot-main-1',
            coreVersion: '2.2.40',
          },
        ),
      ).rejects.toThrow('not enrolled');

      await database.initializeCluster({ appId, deploymentId, members: ['main', 'backup'], policy });
      const initializedMembers = await database.readClusterMembers(appId, deploymentId);
      expect(initializedMembers.map((member) => [member.nodeId, member.state])).toEqual([
        ['backup', 'never-started'],
        ['main', 'never-started'],
      ]);
      await database.registerClusterMember(
        { appId, deploymentId },
        {
          nodeId: 'main',
          bootId: 'boot-main-1',
          coreVersion: '2.2.40',
        },
      );

      const firstOwner = await database.acquireClusterAuthority(
        { appId, deploymentId },
        'main',
        'owner-token-1',
        30_000,
      );
      await app.db.sequelize.query(
        `UPDATE ${app.db
          .getCollection('startupGuardianClusterState')
          .quotedTableName()} SET "ownerLeaseExpiresAt" = clock_timestamp() - interval '1 second' WHERE "appId" = :appId AND "deploymentId" = :deploymentId`,
        { replacements: { appId, deploymentId } },
      );
      const successor = await database.acquireClusterAuthority(
        { appId, deploymentId },
        'backup',
        'owner-token-2',
        30_000,
      );
      expect(successor.fence).toBeGreaterThan(firstOwner.fence);
      await expect(
        database.beginClusterDrain({ appId, deploymentId }, firstOwner, {
          type: 'quarantine',
          target: target(),
          incident: incident(),
        }),
      ).rejects.toThrow('fence or lease is stale');

      const drain = await database.beginClusterDrain({ appId, deploymentId }, successor, {
        type: 'quarantine',
        target: target(),
        incident: incident(),
      });
      expect(drain.participants).toEqual([{ nodeId: 'main', bootId: 'boot-main-1' }]);
      await expect(
        database.quarantineClusterPlugin({
          authority: successor,
          drainRevision: drain.drainRevision,
          target: target(),
          incident: incident(),
          assertNoMandatoryDependent: async () => {},
        }),
      ).rejects.toThrow('has not confirmed');
      await database.acknowledgeClusterStopped({ appId, deploymentId }, 'main', 'boot-main-1', drain.drainRevision);

      const receipt = await database.quarantineClusterPlugin({
        authority: successor,
        drainRevision: drain.drainRevision,
        target: target(),
        incident: incident(),
        assertNoMandatoryDependent: async () => {},
      });
      expect(receipt.status).toBe('quarantined');
      expect(await database.readPlugin(target())).toMatchObject({
        enabled: false,
        installed: true,
        options: { keep: 'original' },
      });
      const control = await database.readClusterControl(appId, deploymentId);
      expect(control).toMatchObject({
        phase: 'ready',
        decisionRevision: 1,
        quarantineAttempts: 1,
        quarantine: { quarantineId: receipt.quarantineId },
      });
      const backup = (await database.readClusterMembers(appId, deploymentId)).find(
        (member) => member.nodeId === 'backup',
      );
      expect(backup).toMatchObject({ state: 'never-started', appliedRevision: 0 });
    } finally {
      await database.close();
    }
  });

  it('updates shared HA policy with a CAS revision and refuses protected-package approvals', async () => {
    const policyDeployment = `${deploymentId}-policy`;
    const database = await StartupGuardianDatabase.connectFromEnvironment();
    try {
      await database.initializeCluster({ appId, deploymentId: policyDeployment, members: ['main'] });
      const initial = await database.readClusterControl(appId, policyDeployment);
      expect(initial?.policyRevision).toBe(0);
      if (!initial) throw new Error('Expected initialized shared HA policy');

      const nextPolicy = {
        ...createApprovedPolicy(),
        revision: 1,
      };
      const updated = await database.updateClusterPolicy({
        appId,
        deploymentId: policyDeployment,
        expectedPolicyRevision: 0,
        policy: nextPolicy,
      });
      expect(updated).toMatchObject({ policyRevision: 1, decisionRevision: 0, policy: { revision: 1 } });
      await expect(
        database.updateClusterPolicy({
          appId,
          deploymentId: policyDeployment,
          expectedPolicyRevision: 0,
          policy: { ...nextPolicy, autoRecoveryEnabled: false },
        }),
      ).rejects.toThrow('HA policy revision changed');

      await expect(
        database.updateClusterPolicy({
          appId,
          deploymentId: policyDeployment,
          expectedPolicyRevision: 1,
          policy: {
            ...updated.policy,
            revision: 2,
            approvedRules: [
              ...updated.policy.approvedRules,
              {
                pluginName: 'cluster-manager',
                packageName: 'plugin-cluster-manager',
                pluginVersion: '1.0.0',
                phase: 'load',
                fingerprint: 'b'.repeat(64),
                approvedBy: 'integration-test',
                approvedAt: new Date().toISOString(),
              },
            ],
          },
        }),
      ).rejects.toThrow('Protected packages cannot be approved');
      expect(await database.readClusterControl(appId, policyDeployment)).toMatchObject({
        policyRevision: 1,
        decisionRevision: 0,
        policy: { autoRecoveryEnabled: true, revision: 1 },
      });
    } finally {
      await database.close();
    }
  });

  it('approves and enables shared HA policy through the revision-checked CLI and refuses shared retry', async () => {
    const policyDeployment = `${deploymentId}-cli-policy`;
    const database = await StartupGuardianDatabase.connectFromEnvironment();
    try {
      await database.initializeCluster({ appId, deploymentId: policyDeployment, members: ['main'] });
      const boot = { nodeId: 'main', bootId: `boot-${randomId()}`, coreVersion: '2.2.40' };
      await database.registerClusterMember({ appId, deploymentId: policyDeployment }, boot);
      const observed = { ...incident(), deploymentId: policyDeployment, bootId: boot.bootId };
      await database.recordClusterIncident({ appId, deploymentId: policyDeployment }, boot, observed);

      expect(
        await startupGuardianCli([
          'cluster',
          'approve',
          observed.eventId,
          '--app-id',
          appId,
          '--deployment-id',
          policyDeployment,
          '--expected-policy-revision',
          '0',
        ]),
      ).toBe(0);
      await expect(database.readClusterControl(appId, policyDeployment)).resolves.toMatchObject({
        policyRevision: 1,
        decisionRevision: 0,
        policy: { autoRecoveryEnabled: false, approvedRules: [{ packageName: 'plugin-faulty-plugin' }] },
      });
      expect(
        await startupGuardianCli([
          'cluster',
          'auto',
          'on',
          '--app-id',
          appId,
          '--deployment-id',
          policyDeployment,
          '--expected-policy-revision',
          '0',
        ]),
      ).toBe(2);
      expect(
        await startupGuardianCli([
          'cluster',
          'auto',
          'on',
          '--app-id',
          appId,
          '--deployment-id',
          policyDeployment,
          '--expected-policy-revision',
          '1',
        ]),
      ).toBe(0);
      expect(await startupGuardianCli(['cluster', 'retry'])).toBe(2);
      await expect(database.readClusterControl(appId, policyDeployment)).resolves.toMatchObject({
        policyRevision: 2,
        decisionRevision: 0,
        policy: { autoRecoveryEnabled: true, revision: 2 },
      });
    } finally {
      await database.close();
    }
  });

  it('rolls back the applicationPlugins change if the shared receipt transaction fails', async () => {
    const rollbackDeployment = `${deploymentId}-rollback`;
    const database = await StartupGuardianDatabase.connectFromEnvironment();
    const policy = createApprovedPolicy();
    const functionName = `guardian_fail_${randomId().replaceAll('-', '').slice(0, 12)}`;
    const triggerName = `${functionName}_trg`;
    const controlTable = app.db.getCollection('startupGuardianClusterState').quotedTableName();
    const quoteIdentifier = getQuoteIdentifier(app.db.sequelize.getQueryInterface().queryGenerator);
    try {
      await database.initializeCluster({ appId, deploymentId: rollbackDeployment, members: ['main'], policy });
      await database.registerClusterMember(
        { appId, deploymentId: rollbackDeployment },
        {
          nodeId: 'main',
          bootId: 'boot-main-rollback',
          coreVersion: '2.2.40',
        },
      );
      const authority = await database.acquireClusterAuthority(
        { appId, deploymentId: rollbackDeployment },
        'main',
        'rollback-owner-token',
        30_000,
      );
      const drain = await database.beginClusterDrain({ appId, deploymentId: rollbackDeployment }, authority, {
        type: 'quarantine',
        target: target(),
        incident: { ...incident(), deploymentId: rollbackDeployment },
      });
      await database.acknowledgeClusterStopped(
        { appId, deploymentId: rollbackDeployment },
        'main',
        'boot-main-rollback',
        drain.drainRevision,
      );
      const fn = quoteIdentifier(functionName);
      const trg = quoteIdentifier(triggerName);
      await app.db.sequelize.query(
        `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."phase" = 'ready' AND NEW."quarantine" IS NOT NULL THEN RAISE EXCEPTION 'injected shared receipt failure'; END IF; RETURN NEW; END $$`,
      );
      await app.db.sequelize.query(
        `CREATE TRIGGER ${trg} BEFORE UPDATE ON ${controlTable} FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
      );
      await expect(
        database.quarantineClusterPlugin({
          authority,
          drainRevision: drain.drainRevision,
          target: target(),
          incident: { ...incident(), deploymentId: rollbackDeployment },
          assertNoMandatoryDependent: async () => {},
        }),
      ).rejects.toThrow('injected shared receipt failure');
      expect(await database.readPlugin(target())).toMatchObject({ enabled: true, options: { keep: 'original' } });
      expect(await database.readClusterControl(appId, rollbackDeployment)).toMatchObject({
        phase: 'draining',
        quarantineAttempts: 0,
        quarantine: undefined,
      });
      await app.db.sequelize.query(`DROP TRIGGER IF EXISTS ${trg} ON ${controlTable}`);
      await app.db.sequelize.query(`DROP FUNCTION IF EXISTS ${fn}()`);
    } finally {
      await database.close();
      await app.db.sequelize
        .query(`DROP TRIGGER IF EXISTS ${quoteIdentifier(triggerName)} ON ${controlTable}`)
        .catch(() => undefined);
      await app.db.sequelize.query(`DROP FUNCTION IF EXISTS ${quoteIdentifier(functionName)}()`).catch(() => undefined);
    }
  });
});

function target() {
  return { pluginName: 'faulty-plugin', packageName: 'plugin-faulty-plugin', pluginVersion: '1.0.0' };
}

function incident(): StartupIncident {
  const fingerprint = 'a'.repeat(64);
  return {
    schemaVersion: 1,
    eventId: `event-${randomId()}`,
    eventType: 'lifecycle-failure',
    appId,
    deploymentId,
    bootId: 'boot-main-failed',
    timestamp: new Date().toISOString(),
    pluginName: 'faulty-plugin',
    packageName: 'plugin-faulty-plugin',
    pluginVersion: '1.0.0',
    phase: 'load',
    errorName: 'Error',
    errorMessage: 'Injected plugin lifecycle failure',
    fingerprint,
  };
}

function createApprovedPolicy() {
  const policy = createDefaultPolicy();
  policy.autoRecoveryEnabled = true;
  policy.approvedRules = [
    {
      pluginName: 'faulty-plugin',
      packageName: 'plugin-faulty-plugin',
      pluginVersion: '1.0.0',
      phase: 'load',
      fingerprint: 'a'.repeat(64),
      approvedBy: 'integration-test',
      approvedAt: new Date().toISOString(),
    },
  ];
  return policy;
}

interface QuoteIdentifierQueryGenerator {
  quoteIdentifier(identifier: string): string;
}

function getQuoteIdentifier(value: unknown): (identifier: string) => string {
  if (!isQuoteIdentifierQueryGenerator(value))
    throw new Error('PostgreSQL query generator does not expose quoteIdentifier');
  return value.quoteIdentifier.bind(value);
}

function isQuoteIdentifierQueryGenerator(value: unknown): value is QuoteIdentifierQueryGenerator {
  return (
    typeof value === 'object' &&
    value !== null &&
    'quoteIdentifier' in value &&
    typeof value.quoteIdentifier === 'function'
  );
}
