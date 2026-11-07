/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultPolicy, isApprovedIncident, writePolicy } from '../policy';
import {
  MAX_INCIDENT_COUNT,
  createInitialState,
  readIncidents,
  readState,
  writeIncident,
  writeState,
} from '../journal';
import { createFingerprint, randomId, redactText } from '../security';
import type { LifecyclePhase, StartupIncident } from '../contracts';

describe('Startup Guardian journal and exact recovery policy', () => {
  let directory = '';

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'startup-guardian-journal-'));
  });

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('stores atomic versioned state and keeps incidents in chronological order with bounded retention', async () => {
    const state = createInitialState({ appId: 'main', deploymentId: 'test' });
    await writeState(state, directory);
    expect(await readState(directory)).toMatchObject({ schemaVersion: 1, appId: 'main', deploymentId: 'test' });

    for (let index = 0; index < MAX_INCIDENT_COUNT + 2; index += 1) {
      await writeIncident(makeIncident(index), directory);
    }

    const incidents = await readIncidents(directory);
    expect(incidents).toHaveLength(MAX_INCIDENT_COUNT);
    expect(incidents[0].timestamp).toBe(makeIncident(2).timestamp);
    expect(incidents.at(-1)?.timestamp).toBe(makeIncident(MAX_INCIDENT_COUNT + 1).timestamp);
  });

  it('requires the full operator-approved fingerprint and rejects protected packages', async () => {
    const incident = makeIncident(1);
    const policy = createDefaultPolicy();
    policy.autoRecoveryEnabled = true;
    policy.approvedRules.push({
      pluginName: incident.pluginName,
      packageName: incident.packageName,
      pluginVersion: incident.pluginVersion,
      phase: incident.phase,
      fingerprint: incident.fingerprint,
      approvedBy: 'test-operator',
      approvedAt: incident.timestamp,
    });
    await writePolicy(policy, directory);

    expect(isApprovedIncident(policy, incident)).toBe(true);
    expect(isApprovedIncident(policy, { ...incident, phase: 'beforeLoad' })).toBe(false);
    expect(isApprovedIncident({ ...policy, autoRecoveryEnabled: false }, incident)).toBe(false);
    expect(isApprovedIncident(policy, { ...incident, packageName: '@nocobase/plugin-core' })).toBe(false);
    for (const packageName of ['plugin-cluster-manager', 'plugin-ha-scheduler']) {
      const coordinationFailure: StartupIncident = {
        ...incident,
        pluginName: packageName,
        packageName,
      };
      coordinationFailure.fingerprint = createFingerprint(coordinationFailure);
      const allowEverythingPolicy = {
        ...policy,
        protectedPackages: [],
        approvedRules: [
          {
            pluginName: coordinationFailure.pluginName,
            packageName: coordinationFailure.packageName,
            pluginVersion: coordinationFailure.pluginVersion,
            phase: coordinationFailure.phase,
            fingerprint: coordinationFailure.fingerprint,
            approvedBy: 'operator',
            approvedAt: coordinationFailure.timestamp,
          },
        ],
      };
      expect(isApprovedIncident(allowEverythingPolicy, coordinationFailure)).toBe(false);
    }

    const databaseFailure: StartupIncident = {
      ...incident,
      errorName: 'SequelizeConnectionError',
      errorMessage: 'connect ECONNREFUSED db:5432',
    };
    databaseFailure.fingerprint = createFingerprint(databaseFailure);
    const infrastructurePolicy = {
      ...policy,
      approvedRules: [
        ...policy.approvedRules,
        {
          pluginName: databaseFailure.pluginName,
          packageName: databaseFailure.packageName,
          pluginVersion: databaseFailure.pluginVersion,
          phase: databaseFailure.phase,
          fingerprint: databaseFailure.fingerprint,
          approvedBy: 'test-operator',
          approvedAt: databaseFailure.timestamp,
        },
      ],
    };
    expect(isApprovedIncident(infrastructurePolicy, databaseFailure)).toBe(false);
  });

  it('redacts common credentials before fingerprinting or displaying error text', () => {
    const summary = redactText('request failed Authorization: Bearer eyJhbGci.token password=hunter2');
    expect(summary).not.toContain('eyJhbGci.token');
    expect(summary).not.toContain('hunter2');
    expect(summary).toContain('[redacted]');
  });

  it('rejects corrupted journal entries instead of silently skipping them', async () => {
    const eventsDirectory = join(directory, 'events');
    mkdirSync(eventsDirectory, { recursive: true });
    writeFileSync(join(eventsDirectory, 'broken.json'), '{not-json');
    await expect(readIncidents(directory)).rejects.toThrow();
  });
});

function makeIncident(index: number, phase: LifecyclePhase = 'load'): StartupIncident {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  const shape = {
    pluginName: 'p0-fixture',
    packageName: 'plugin-p0-fixture',
    pluginVersion: '1.0.0',
    phase,
    errorName: 'Error',
    errorMessage: `fault-${index}`,
  };
  return {
    schemaVersion: 1,
    eventId: randomId(),
    eventType: 'lifecycle-failure',
    appId: 'main',
    deploymentId: 'test',
    bootId: randomId(),
    timestamp,
    ...shape,
    fingerprint: createFingerprint(shape),
  };
}
