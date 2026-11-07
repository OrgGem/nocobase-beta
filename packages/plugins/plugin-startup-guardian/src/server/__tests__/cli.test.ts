/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startupGuardianCli } from '../cli';
import { readPolicy } from '../policy';
import { writeIncident } from '../journal';
import { createFingerprint, randomId } from '../security';
import type { StartupIncident } from '../contracts';

describe('Startup Guardian operator CLI', () => {
  let stateDirectory = '';
  const environmentKeys = [
    'STARTUP_GUARDIAN_STATE_DIR',
    'STARTUP_GUARDIAN_APP_ID',
    'STARTUP_GUARDIAN_DEPLOYMENT_ID',
    'STARTUP_GUARDIAN_CLUSTER_MODE',
  ] as const;
  const originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    stateDirectory = mkdtempSync(join(tmpdir(), 'startup-guardian-cli-'));
    process.env.STARTUP_GUARDIAN_STATE_DIR = stateDirectory;
    process.env.STARTUP_GUARDIAN_APP_ID = 'cli-test';
    process.env.STARTUP_GUARDIAN_DEPLOYMENT_ID = 'isolated';
  });

  afterEach(() => {
    if (stateDirectory) rmSync(stateDirectory, { recursive: true, force: true });
    for (const key of environmentKeys) {
      const value = originalEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('approves only a journaled incident and keeps auto-recovery disabled until separately enabled', async () => {
    const incident = createIncident();
    await writeIncident(incident, stateDirectory);

    expect(await startupGuardianCli(['approve', incident.eventId])).toBe(0);
    let policy = await readPolicy(stateDirectory);
    expect(policy.approvedRules).toMatchObject([
      {
        pluginName: incident.pluginName,
        packageName: incident.packageName,
        pluginVersion: incident.pluginVersion,
        phase: incident.phase,
        fingerprint: incident.fingerprint,
        approvedBy: 'local-operator',
      },
    ]);
    expect(policy.autoRecoveryEnabled).toBe(false);

    expect(await startupGuardianCli(['auto', 'on'])).toBe(0);
    policy = await readPolicy(stateDirectory);
    expect(policy.autoRecoveryEnabled).toBe(true);
  });

  it('refuses an unknown command without spawning a process', async () => {
    await expect(startupGuardianCli(['run', 'untrusted-command'])).resolves.toBe(2);
  });

  it('requires explicit app-only and all-nodes-stopped acknowledgements for HA enrollment', async () => {
    await expect(
      startupGuardianCli([
        'cluster',
        'init',
        '--app-id',
        'cli-test',
        '--deployment-id',
        'isolated',
        '--members',
        'main,backup',
      ]),
    ).resolves.toBe(2);
  });

  it('refuses single-node policy and retry commands while HA mode is selected', async () => {
    process.env.STARTUP_GUARDIAN_CLUSTER_MODE = 'redis-postgres';
    await expect(startupGuardianCli(['auto', 'on'])).resolves.toBe(2);
    await expect(startupGuardianCli(['approve', 'event-id'])).resolves.toBe(2);
    await expect(startupGuardianCli(['retry', 'plugin-example', '--expected-revision', '1'])).resolves.toBe(2);
    await expect(startupGuardianCli(['cluster', 'retry'])).resolves.toBe(2);
  });
});

function createIncident(): StartupIncident {
  const shape = {
    pluginName: 'cli-fixture',
    packageName: 'plugin-cli-fixture',
    pluginVersion: '1.0.0',
    phase: 'load' as const,
    errorName: 'Error',
    errorMessage: 'fixture failure',
  };
  return {
    schemaVersion: 1,
    eventId: randomId(),
    eventType: 'lifecycle-failure',
    appId: 'cli-test',
    deploymentId: 'isolated',
    bootId: randomId(),
    timestamp: new Date().toISOString(),
    ...shape,
    fingerprint: createFingerprint(shape),
  };
}
