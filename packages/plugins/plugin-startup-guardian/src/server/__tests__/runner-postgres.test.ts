/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mockServer } from '@nocobase/test';
import { createFingerprint, randomId } from '../security';
import { createDefaultPolicy, requestRetry, writePolicy } from '../policy';
import { startGuardianSupervisor } from '../runner';
import { StartupGuardianDatabase } from '../database-adapter';
import { readState } from '../journal';
import type { GuardianState, QuarantineTarget } from '../contracts';

const databaseName = process.env.STARTUP_GUARDIAN_TEST_DB_DATABASE || 'guardian_test';
const databaseHost = process.env.STARTUP_GUARDIAN_TEST_DB_HOST || '127.0.0.1';
const databasePort = process.env.STARTUP_GUARDIAN_TEST_DB_PORT || '55432';
const databaseUser = process.env.STARTUP_GUARDIAN_TEST_DB_USER || 'guardian_test';
const databasePassword = process.env.STARTUP_GUARDIAN_TEST_DB_PASSWORD || 'guardian_test_only';
const schema = 'public';
const prefix = `g_${randomId().replaceAll('-', '').slice(0, 10)}_`;
const appId = 'main';

describe('Startup Guardian PostgreSQL recovery prototype', () => {
  const envKeys = [
    'DB_DIALECT',
    'DB_HOST',
    'DB_PORT',
    'DB_DATABASE',
    'DB_USER',
    'DB_PASSWORD',
    'DB_SCHEMA',
    'DB_TABLE_PREFIX',
    'NODE_MODULES_PATH',
    'PLUGIN_PACKAGE_PREFIX',
  ] as const;
  const originalEnvironment = new Map(envKeys.map((key) => [key, process.env[key]]));
  let fixtureDirectory = '';
  let stateDirectory = '';
  let dependencyStateDirectory = '';
  let adminEditStateDirectory = '';
  let failureMarkerPath = '';
  let supervisor: ReturnType<typeof startGuardianSupervisor> | undefined;
  let observeStateDirectory = '';

  beforeAll(async () => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), 'guardian-p0-'));
    stateDirectory = join(fixtureDirectory, 'state');
    observeStateDirectory = join(fixtureDirectory, 'observe-state');
    dependencyStateDirectory = join(fixtureDirectory, 'dependency-state');
    adminEditStateDirectory = join(fixtureDirectory, 'admin-edit-state');
    failureMarkerPath = join(fixtureDirectory, 'fail-p0-plugin');
    writeFileSync(failureMarkerPath, 'fail');
    const nodeModulesPath = join(fixtureDirectory, 'node_modules');
    const faultPackage = join(nodeModulesPath, 'plugin-p0-fault');
    const dependentPackage = join(nodeModulesPath, 'plugin-p0-dependent');
    mkdirSync(join(faultPackage, 'dist', 'client'), { recursive: true });
    mkdirSync(join(faultPackage, 'dist', 'client-v2'), { recursive: true });
    writeFileSync(
      join(faultPackage, 'package.json'),
      JSON.stringify({ name: 'plugin-p0-fault', version: '1.0.0', main: 'index.js' }),
    );
    writeFileSync(
      join(faultPackage, 'index.js'),
      [
        "const fs = require('node:fs');",
        "const { Plugin } = require('@nocobase/server');",
        'module.exports = class P0FaultPlugin extends Plugin {',
        "  async load() { if (fs.existsSync(process.env.STARTUP_GUARDIAN_P0_FAIL_MARKER)) { fs.writeFileSync(require('node:path').join(process.env.STARTUP_GUARDIAN_STATE_DIR, `p0-failed-child-${process.env.STARTUP_GUARDIAN_BOOT_ID}.pid`), String(process.pid)); throw new Error('P0-FAULT-INJECTED-LOAD-ERROR'); } }",
        '};',
      ].join('\n'),
    );
    writeFileSync(join(faultPackage, 'client.js'), 'module.exports = class P0FaultClient {};\n');
    writeFileSync(join(faultPackage, 'client-v2.js'), 'module.exports = class P0FaultClientV2 {};\n');
    writeFileSync(join(faultPackage, 'dist', 'client', 'index.js'), 'export default class P0FaultClient {}\n');
    writeFileSync(join(faultPackage, 'dist', 'client-v2', 'index.js'), 'export default class P0FaultClientV2 {}\n');
    mkdirSync(dependentPackage, { recursive: true });
    writeFileSync(
      join(dependentPackage, 'package.json'),
      JSON.stringify({
        name: 'plugin-p0-dependent',
        version: '1.0.0',
        main: 'index.js',
        dependencies: { 'plugin-p0-fault': '1.0.0' },
      }),
    );
    writeFileSync(
      join(dependentPackage, 'index.js'),
      [
        "const { Plugin } = require('@nocobase/server');",
        'module.exports = class P0DependentPlugin extends Plugin {};',
      ].join('\n'),
    );

    process.env.DB_DIALECT = 'postgres';
    process.env.DB_HOST = databaseHost;
    process.env.DB_PORT = databasePort;
    process.env.DB_DATABASE = databaseName;
    process.env.DB_USER = databaseUser;
    process.env.DB_PASSWORD = databasePassword;
    process.env.DB_SCHEMA = schema;
    process.env.DB_TABLE_PREFIX = prefix;
    process.env.NODE_MODULES_PATH = nodeModulesPath;
    process.env.PLUGIN_PACKAGE_PREFIX = 'plugin-';

    const app = mockServer({
      name: appId,
      database: databaseOptions(),
      plugins: [],
    });
    try {
      await app.db.sync();
      await app.pm.repository.create({
        values: {
          name: 'p0-fault',
          packageName: 'plugin-p0-fault',
          version: '0.0.0',
          enabled: true,
          installed: true,
          builtIn: false,
          options: { proofMarker: 'preserve-this-json' },
        },
      });
      await app.pm.repository.create({
        values: {
          name: 'p0-dependent',
          packageName: 'plugin-p0-dependent',
          version: '1.0.0',
          enabled: false,
          installed: true,
          builtIn: false,
          options: { proofMarker: 'dependent' },
        },
      });
      const tables = (await app.db.sequelize.getQueryInterface().showAllTables()).map(String);
      expect(tables).toContain(`${prefix}applicationPlugins`);
    } finally {
      await app.destroy();
    }
  });

  afterAll(async () => {
    await supervisor?.stop();
    if (supervisor) await supervisor.done;
    if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true });
    for (const key of envKeys) {
      const value = originalEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('keeps an unapproved failure in observe mode and leaves the core row enabled', async () => {
    const observer = startSupervisorFor(observeStateDirectory, failureMarkerPath);
    const state = await waitForGuardianState(observeStateDirectory, 'recovery-required', observer.done);
    expect(await Promise.race([observer.done.then(() => 'finished'), delay(100).then(() => 'waiting')])).toBe(
      'waiting',
    );
    await observer.stop();
    expect(await observer.done).toBe(0);
    expect(state).toMatchObject({
      state: 'recovery-required',
      quarantineAttempts: 0,
      detail: 'No exact approved auto-recovery policy matches this incident',
      incident: {
        pluginName: 'p0-fault',
        phase: 'load',
        errorMessage: 'P0-FAULT-INJECTED-LOAD-ERROR',
      },
    });
    expect(state.quarantine).toBeUndefined();

    const database = await StartupGuardianDatabase.connectFromEnvironment();
    try {
      const row = await database.readPlugin({
        pluginName: 'p0-fault',
        packageName: 'plugin-p0-fault',
        pluginVersion: '0.0.0',
      });
      expect(row).toMatchObject({ enabled: true, installed: true, options: { proofMarker: 'preserve-this-json' } });
    } finally {
      await database.close();
    }
  });

  it('quarantines an exact approved failure, stops the old process and starts a healthy app from the core plugin row', async () => {
    const incidentShape = {
      pluginName: 'p0-fault',
      packageName: 'plugin-p0-fault',
      pluginVersion: '0.0.0',
      phase: 'load' as const,
      errorName: 'Error',
      errorMessage: 'P0-FAULT-INJECTED-LOAD-ERROR',
    };
    const fingerprint = createFingerprint(incidentShape);
    const policy = createDefaultPolicy();
    policy.autoRecoveryEnabled = true;
    policy.approvedRules.push({
      pluginName: incidentShape.pluginName,
      packageName: incidentShape.packageName,
      pluginVersion: incidentShape.pluginVersion,
      phase: incidentShape.phase,
      fingerprint,
      approvedBy: 'p0-test-operator',
      approvedAt: new Date().toISOString(),
    });
    await writePolicy(policy, stateDirectory);

    supervisor = startSupervisorFor(stateDirectory, failureMarkerPath);

    await waitForFile(join(stateDirectory, 'p0-second-app-proof.json'), 60_000, supervisor.done);
    const proof = JSON.parse(
      await (await import('node:fs/promises')).readFile(join(stateDirectory, 'p0-second-app-proof.json'), 'utf8'),
    ) as {
      appLoaded: boolean;
      appStarted: boolean;
      pid: number;
      pmResourceDefined: boolean;
      appHasFaultInstance: boolean;
      faultRowEnabled: boolean;
      v1Status: number;
      v1DataIsArray: boolean;
      v1ContainsFault: boolean;
      v2Status: number;
      v2DataIsArray: boolean;
      v2ContainsFault: boolean;
    };
    expect(proof).toEqual({
      appLoaded: true,
      appStarted: true,
      pid: expect.any(Number),
      pmResourceDefined: true,
      appHasFaultInstance: false,
      faultRowEnabled: false,
      v1Status: 200,
      v1DataIsArray: true,
      v1ContainsFault: false,
      v2Status: 200,
      v2DataIsArray: true,
      v2ContainsFault: false,
    });

    const state = JSON.parse(
      await (await import('node:fs/promises')).readFile(join(stateDirectory, 'state.json'), 'utf8'),
    ) as {
      appId: string;
      deploymentId: string;
      state: string;
      bootId: string;
      revision: number;
      quarantineAttempts: number;
      quarantine?: {
        status: string;
        incident: { bootId: string; pluginName: string; phase: string; errorMessage: string };
        prior: { enabled: boolean; installed: boolean; version: string; options: unknown };
        postUpdateTimestamp: string;
      };
    };
    expect(state).toMatchObject({ appId, deploymentId: 'p0-isolated', state: 'ready' });
    expect(state.quarantine).toMatchObject({
      status: 'quarantined',
      incident: {
        pluginName: incidentShape.pluginName,
        phase: incidentShape.phase,
        errorMessage: incidentShape.errorMessage,
      },
      prior: {
        enabled: true,
        installed: true,
        version: '0.0.0',
        options: { proofMarker: 'preserve-this-json' },
      },
    });
    expect(state.quarantine?.incident.bootId).not.toBe(state.bootId);
    const failedBootId = state.quarantine?.incident.bootId;
    if (!failedBootId) throw new Error('Quarantine receipt omitted the failed boot identity');
    const fileSystem = await import('node:fs/promises');
    const failedChildPid = Number(
      await fileSystem.readFile(join(stateDirectory, `p0-failed-child-${failedBootId}.pid`), 'utf8'),
    );
    expect(Number.isInteger(failedChildPid)).toBe(true);
    expect(proof.pid).not.toBe(failedChildPid);
    expect(state.quarantineAttempts).toBe(1);
    const incidentFiles = await (await import('node:fs/promises')).readdir(join(stateDirectory, 'events'));
    expect(incidentFiles).toHaveLength(1);

    const database = await StartupGuardianDatabase.connectFromEnvironment();
    try {
      const target: QuarantineTarget = {
        pluginName: 'p0-fault',
        packageName: 'plugin-p0-fault',
        pluginVersion: '0.0.0',
      };
      const row = await database.readPlugin(target);
      expect(row).toMatchObject({
        enabled: false,
        installed: true,
        builtIn: false,
        options: { proofMarker: 'preserve-this-json' },
      });
    } finally {
      await database.close();
    }
    const firstRecoveredBootId = state.bootId;
    await supervisor.stop();
    expect(await supervisor.done).toBe(0);

    supervisor = startSupervisorFor(stateDirectory, failureMarkerPath);
    const restartedState = await waitForGuardianState(
      stateDirectory,
      'ready',
      supervisor.done,
      (value) => value.bootId !== firstRecoveredBootId,
    );
    expect(restartedState.quarantineAttempts).toBe(1);
    expect(restartedState.quarantine?.status).toBe('quarantined');
    const retryBootId = restartedState.bootId;
    rmSync(failureMarkerPath, { force: true });
    const retryRequest = await requestRetry(
      { packageName: 'plugin-p0-fault', expectedRevision: restartedState.revision, requestedBy: 'p0-test-operator' },
      stateDirectory,
    );
    expect(retryRequest.expectedRevision).toBe(restartedState.revision);
    const retriedState = await waitForGuardianState(
      stateDirectory,
      'ready',
      supervisor.done,
      (value) => value.bootId !== retryBootId && value.quarantine?.status === 'cleared',
    );
    expect(retriedState.quarantineAttempts).toBe(1);
    await waitForFile(join(stateDirectory, `p0-second-app-proof-${retriedState.bootId}.json`), 10_000, supervisor.done);
    const retryProof = JSON.parse(
      await (
        await import('node:fs/promises')
      ).readFile(join(stateDirectory, `p0-second-app-proof-${retriedState.bootId}.json`), 'utf8'),
    ) as {
      pid: number;
      appHasFaultInstance: boolean;
      faultRowEnabled: boolean;
      v1ContainsFault: boolean;
      v2ContainsFault: boolean;
    };
    expect(retryProof).toMatchObject({
      pid: expect.any(Number),
      appHasFaultInstance: true,
      faultRowEnabled: true,
      v1ContainsFault: true,
      v2ContainsFault: true,
    });
    expect(retryProof.pid).not.toBe(proof.pid);
    await supervisor.stop();
    expect(await supervisor.done).toBe(0);
    supervisor = undefined;
  });

  it('rejects a stale retry and detects a microsecond administrator timestamp edit', async () => {
    writeFileSync(failureMarkerPath, 'fail');
    const policy = createDefaultPolicy();
    policy.autoRecoveryEnabled = true;
    policy.approvedRules.push({
      pluginName: 'p0-fault',
      packageName: 'plugin-p0-fault',
      pluginVersion: '0.0.0',
      phase: 'load',
      fingerprint: createFingerprint({
        pluginName: 'p0-fault',
        packageName: 'plugin-p0-fault',
        pluginVersion: '0.0.0',
        phase: 'load',
        errorName: 'Error',
        errorMessage: 'P0-FAULT-INJECTED-LOAD-ERROR',
      }),
      approvedBy: 'p0-test-operator',
      approvedAt: new Date().toISOString(),
    });
    await writePolicy(policy, adminEditStateDirectory);

    const adminEditRunner = startSupervisorFor(adminEditStateDirectory, failureMarkerPath);
    supervisor = adminEditRunner;
    const quarantinedState = await waitForGuardianState(
      adminEditStateDirectory,
      'ready',
      adminEditRunner.done,
      (value) => value.quarantine?.status === 'quarantined',
    );
    expect(quarantinedState.quarantine?.status).toBe('quarantined');

    const databaseApp = mockServer({ name: appId, database: databaseOptions(), plugins: [] });
    try {
      const postQuarantineTimestamp = quarantinedState.quarantine?.postUpdateTimestamp;
      if (!postQuarantineTimestamp) throw new Error('Quarantine receipt omitted its exact PostgreSQL timestamp');
      const timestampParts = postQuarantineTimestamp.match(/^(.*\.\d{3})([+-]\d{2}(?::\d{2})?)$/);
      if (!timestampParts) throw new Error(`Unexpected PostgreSQL timestamp format: ${postQuarantineTimestamp}`);
      const exactMicrosecondEdit = `${timestampParts[1]}001${timestampParts[2]}`;
      await databaseApp.db.sequelize.query(
        `UPDATE ${databaseApp.db
          .getCollection('applicationPlugins')
          .quotedTableName()} SET "updatedAt" = CAST(:updatedAt AS timestamptz) WHERE "name" = :name AND "packageName" = :packageName`,
        {
          replacements: {
            updatedAt: exactMicrosecondEdit,
            name: 'p0-fault',
            packageName: 'plugin-p0-fault',
          },
        },
      );
      const database = await StartupGuardianDatabase.connectFromEnvironment();
      try {
        const editedRow = await database.readPlugin({
          pluginName: 'p0-fault',
          packageName: 'plugin-p0-fault',
          pluginVersion: '0.0.0',
        });
        if (!editedRow) throw new Error('Administrator-edited applicationPlugins row was not found');
        expect(editedRow.updatedAtExact).toBe(exactMicrosecondEdit);
        expect(new Date(editedRow.updatedAtExact).getTime()).toBe(new Date(postQuarantineTimestamp).getTime());
      } finally {
        await database.close();
      }
    } finally {
      await databaseApp.destroy();
    }

    await expect(
      requestRetry(
        {
          packageName: 'plugin-p0-fault',
          expectedRevision: quarantinedState.revision - 1,
          requestedBy: 'stale-operator',
        },
        adminEditStateDirectory,
      ),
    ).rejects.toThrow('Startup Guardian state changed');
    expect(existsSync(join(adminEditStateDirectory, 'retry-request.json'))).toBe(false);

    await requestRetry(
      {
        packageName: 'plugin-p0-fault',
        expectedRevision: quarantinedState.revision,
        requestedBy: 'current-operator',
      },
      adminEditStateDirectory,
    );
    const recoveryState = await waitForGuardianState(
      adminEditStateDirectory,
      'recovery-required',
      adminEditRunner.done,
    );
    expect(recoveryState.detail).toContain('Retry request failed its revision or quarantine checks');
    await adminEditRunner.stop();
    expect(await adminEditRunner.done).toBe(0);
    supervisor = undefined;

    const database = await StartupGuardianDatabase.connectFromEnvironment();
    try {
      const row = await database.readPlugin({
        pluginName: 'p0-fault',
        packageName: 'plugin-p0-fault',
        pluginVersion: '0.0.0',
      });
      expect(row).toMatchObject({
        enabled: false,
        installed: true,
        options: { proofMarker: 'preserve-this-json' },
      });
    } finally {
      await database.close();
    }
  });

  it('refuses an exact approved failure when an enabled plugin declares a mandatory dependent', async () => {
    const setupApp = mockServer({ name: appId, database: databaseOptions(), plugins: [] });
    try {
      await setupApp.pm.repository.update({ filter: { name: 'p0-fault' }, values: { enabled: true } });
      await setupApp.pm.repository.update({ filter: { name: 'p0-dependent' }, values: { enabled: true } });
    } finally {
      await setupApp.destroy();
    }

    const fingerprint = createFingerprint({
      pluginName: 'p0-fault',
      packageName: 'plugin-p0-fault',
      pluginVersion: '0.0.0',
      phase: 'load',
      errorName: 'Error',
      errorMessage: 'P0-FAULT-INJECTED-LOAD-ERROR',
    });
    const policy = createDefaultPolicy();
    policy.autoRecoveryEnabled = true;
    policy.approvedRules.push({
      pluginName: 'p0-fault',
      packageName: 'plugin-p0-fault',
      pluginVersion: '0.0.0',
      phase: 'load',
      fingerprint,
      approvedBy: 'p0-test-operator',
      approvedAt: new Date().toISOString(),
    });
    await writePolicy(policy, dependencyStateDirectory);

    writeFileSync(failureMarkerPath, 'fail');
    const dependencyRunner = startSupervisorFor(dependencyStateDirectory, failureMarkerPath);
    const state = await waitForGuardianState(dependencyStateDirectory, 'recovery-required', dependencyRunner.done);
    expect(await Promise.race([dependencyRunner.done.then(() => 'finished'), delay(100).then(() => 'waiting')])).toBe(
      'waiting',
    );
    await dependencyRunner.stop();
    expect(await dependencyRunner.done).toBe(0);
    expect(state.state).toBe('recovery-required');
    expect(state.quarantineAttempts).toBe(0);
    expect(state.quarantine).toBeUndefined();
    expect(state.detail).toContain('plugin-p0-dependent has a mandatory dependency on plugin-p0-fault');

    const database = await StartupGuardianDatabase.connectFromEnvironment();
    try {
      const target = await database.readPlugin({
        pluginName: 'p0-fault',
        packageName: 'plugin-p0-fault',
        pluginVersion: '0.0.0',
      });
      expect(target).toMatchObject({ enabled: true, installed: true });
    } finally {
      await database.close();
    }
  });
});

function databaseOptions() {
  return {
    dialect: 'postgres' as const,
    host: databaseHost,
    port: Number(databasePort),
    database: databaseName,
    username: databaseUser,
    password: databasePassword,
    schema,
    tablePrefix: prefix,
    logging: false,
  };
}

async function waitForGuardianState(
  stateDirectory: string,
  expectedState: GuardianState['state'],
  done: Promise<number>,
  additionalCheck: (state: GuardianState) => boolean = () => true,
): Promise<GuardianState> {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const state = await readState(stateDirectory);
    if (state?.state === expectedState && additionalCheck(state)) return state;
    const result = await Promise.race([done.then((exitCode) => exitCode), delay(100).then(() => null)]);
    if (result !== null) throw new Error(`Supervisor ended before state ${expectedState} (code ${result})`);
  }
  const lastState = await readState(stateDirectory);
  throw new Error(
    `Timed out waiting for Startup Guardian state ${expectedState}; last state=${JSON.stringify(lastState)}`,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function startSupervisorFor(
  stateDirectory: string,
  failureMarkerPath: string,
): ReturnType<typeof startGuardianSupervisor> {
  const workerPath = resolve(__dirname, 'fixtures', 'p0-app-worker.ts');
  const nodeModulesPath = process.env.NODE_MODULES_PATH as string;
  const env = {
    DB_DIALECT: 'postgres',
    DB_HOST: databaseHost,
    DB_PORT: databasePort,
    DB_DATABASE: databaseName,
    DB_USER: databaseUser,
    DB_PASSWORD: databasePassword,
    DB_SCHEMA: schema,
    DB_TABLE_PREFIX: prefix,
    NODE_MODULES_PATH: nodeModulesPath,
    NODE_PATH: [nodeModulesPath, resolve(process.cwd(), 'node_modules')].join(delimiter),
    PLUGIN_PACKAGE_PREFIX: 'plugin-',
    STARTUP_GUARDIAN_P0_FAIL_MARKER: failureMarkerPath,
    VITEST: '',
    STARTUP_GUARDIAN_APP_ID: appId,
    STARTUP_GUARDIAN_DEPLOYMENT_ID: 'p0-isolated',
    STARTUP_GUARDIAN_STATE_DIR: stateDirectory,
  };
  return startGuardianSupervisor({
    command: process.execPath,
    args: ['--import', 'tsx', '--import', 'tsconfig-paths/register', workerPath],
    cwd: process.cwd(),
    env,
    stateDirectory,
    appId,
    deploymentId: 'p0-isolated',
    startupTimeoutMs: 45_000,
    terminateTimeoutMs: 5_000,
    retryPollIntervalMs: 250,
    stdio: 'inherit',
  });
}

async function waitForFile(filePath: string, timeoutMs: number, done: Promise<number>): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await (await import('node:fs/promises')).access(filePath);
      return;
    } catch {
      const result = await Promise.race([done, new Promise<null>((resolve) => setTimeout(() => resolve(null), 100))]);
      if (result !== null) {
        const evidenceDirectory = dirname(filePath);
        const evidence = await (
          await import('node:fs/promises')
        )
          .readdir(evidenceDirectory)
          .then(async (names) =>
            Promise.all(
              names
                .filter((name) => name === 'state.json' || name.startsWith('events'))
                .map(async (name) => {
                  if (name === 'events') {
                    const eventNames = await (await import('node:fs/promises')).readdir(join(evidenceDirectory, name));
                    const events = await Promise.all(
                      eventNames.map(async (eventName) =>
                        (await import('node:fs/promises')).readFile(join(evidenceDirectory, name, eventName), 'utf8'),
                      ),
                    );
                    return `${name}: ${events.join('\n')}`;
                  }
                  return `${name}: ${await (
                    await import('node:fs/promises')
                  ).readFile(join(evidenceDirectory, name), 'utf8')}`;
                }),
            ),
          )
          .catch((error: unknown) => [
            `evidence unavailable: ${error instanceof Error ? error.message : String(error)}`,
          ]);
        throw new Error(
          `Supervisor exited before the recovered app became ready (code ${result})\n${evidence.join('\n')}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`Timed out waiting for runner evidence at ${filePath}`);
}
