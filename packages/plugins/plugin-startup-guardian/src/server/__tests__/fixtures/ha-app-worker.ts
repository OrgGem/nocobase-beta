/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mockServer } from '@nocobase/test';
import { PluginManager } from '@nocobase/server';
import PluginStartupGuardianServer from '../../plugin';

const appId = process.env.STARTUP_GUARDIAN_APP_ID || 'main';
const nodeId = process.env.STARTUP_GUARDIAN_NODE_ID || 'unknown-node';
const deploymentId = process.env.STARTUP_GUARDIAN_DEPLOYMENT_ID || 'unknown-deployment';
const faultPluginName = process.env.STARTUP_GUARDIAN_FAULT_PLUGIN_NAME || 'unknown-plugin';
const coreGetPackageJson = PluginManager.getPackageJson;
const bootId = process.env.STARTUP_GUARDIAN_BOOT_ID || 'unknown-boot';
const proofDirectory = process.env.STARTUP_GUARDIAN_CLUSTER_PROOF_DIR || '';
const mainBootGateFile = process.env.STARTUP_GUARDIAN_TEST_MAIN_BOOT_GATE_FILE || '';
const stopSignal = new Promise<void>((resolve) => process.once('SIGTERM', resolve));

async function main(): Promise<void> {
  if (!(await waitForMainBootGate())) return;
  const app = mockServer({
    name: appId,
    database: {
      dialect: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_DATABASE,
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      schema: process.env.DB_SCHEMA,
      tablePrefix: process.env.DB_TABLE_PREFIX,
      logging: false,
    },
    resourcer: { prefix: '/api' },
    plugins: [[PluginStartupGuardianServer, { name: 'plugin-startup-guardian', enabled: true, isPreset: true }]],
  });
  PluginManager.getPackageJson = coreGetPackageJson;

  try {
    await app.load();
    const beforeStart = await app.agent().resource('startupGuardian').status();
    let sawInitialGate = beforeStart.status === 503;
    await app.start();
    if (proofDirectory) await mkdir(proofDirectory, { recursive: true });
    let receivedReady = false;
    while (!receivedReady) {
      const response = await app.agent().resource('startupGuardian').status();
      if (response.status === 200) {
        const statusPayload = asRecord(asRecord(response.body)?.data);
        const clusterStatus = asRecord(statusPayload?.cluster);
        if (
          statusPayload?.mode !== 'redis-postgres-app-only-ha' ||
          statusPayload.policyMutationSupported !== true ||
          statusPayload.retrySupported !== false ||
          typeof clusterStatus?.decisionRevision !== 'number' ||
          typeof clusterStatus.policyRevision !== 'number'
        ) {
          throw new Error('HA status HTTP response did not expose the shared control contract');
        }
        const inspectResponse = await app.agent().resource('startupGuardian').inspect();
        const inspectPayload = asRecord(asRecord(inspectResponse.body)?.data);
        if (inspectResponse.status !== 200 || !Array.isArray(inspectPayload?.incidents)) {
          throw new Error('HA inspect HTTP response did not expose the shared incident list');
        }
        receivedReady = true;
        await writeFile(
          join(proofDirectory, `${deploymentId}-${nodeId}-${bootId}.json`),
          JSON.stringify({
            nodeId,
            deploymentId,
            bootId,
            pid: process.pid,
            httpStatus: response.status,
            sawInitialGate,
            pluginLoaded: Boolean(app.pm.get(faultPluginName)),
            mode: statusPayload.mode,
            decisionRevision: clusterStatus.decisionRevision,
            policyRevision: clusterStatus.policyRevision,
            inspectHttpStatus: inspectResponse.status,
          }),
          'utf8',
        );
      } else if (response.status === 503) {
        sawInitialGate = true;
      } else {
        throw new Error(`HA readiness HTTP request returned unexpected status ${response.status}`);
      }
      await delay(50);
    }

    while (!(await isStopRequested(stopSignal))) {
      const response = await app.agent().resource('startupGuardian').status();
      if (response.status === 503 && proofDirectory) {
        await appendFile(
          join(proofDirectory, `${deploymentId}-${nodeId}-${bootId}.drained.log`),
          `${Date.now()}\n`,
          'utf8',
        );
      } else if (response.status !== 200) {
        throw new Error(`HA steady-state HTTP status was ${response.status}`);
      }
      await delay(50);
    }
  } catch (error) {
    process.stderr.write(
      `${nodeId} app child: ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
    );
    await waitForStopSignal();
  } finally {
    await app.destroy();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function waitForMainBootGate(): Promise<boolean> {
  if (nodeId !== 'main' || !mainBootGateFile) return true;
  for (;;) {
    if (await isStopRequested(stopSignal)) return false;
    let gateValue: string;
    try {
      gateValue = await readFile(mainBootGateFile, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) return true;
      throw error;
    }
    if (gateValue.trim() !== 'hold') return true;
    await delay(20);
  }
}

function isMissingFileError(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'code' in value && value.code === 'ENOENT';
}

function isStopRequested(signal: Promise<void>): Promise<boolean> {
  return Promise.race([signal.then(() => true), delay(1).then(() => false)]);
}

function waitForStopSignal(): Promise<void> {
  return stopSignal;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
