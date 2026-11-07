/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startGuardianSupervisor } from '../../runner';

const workerPath = resolve(__dirname, 'ha-app-worker.ts');
const bootstrapPath = resolve(__dirname, 'ha-process-bootstrap.cjs');
const appId = process.env.STARTUP_GUARDIAN_APP_ID || 'main';
const deploymentId = process.env.STARTUP_GUARDIAN_DEPLOYMENT_ID || 'unknown-deployment';
const stateDirectory = process.env.STARTUP_GUARDIAN_STATE_DIR || '';

const supervisor = startGuardianSupervisor({
  command: process.execPath,
  args: [
    '--import',
    pathToFileURL(bootstrapPath).href,
    '--import',
    'tsx',
    '--import',
    'tsconfig-paths/register',
    workerPath,
  ],
  cwd: process.cwd(),
  stateDirectory,
  appId,
  deploymentId,
  startupTimeoutMs: 45_000,
  terminateTimeoutMs: 5_000,
  retryPollIntervalMs: 100,
  stdio: 'inherit',
});

let stopping = false;
process.on('message', (message: unknown) => {
  if (stopping || !isStopMessage(message)) return;
  stopping = true;
  stopSupervisor().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
});

async function stopSupervisor(): Promise<void> {
  await supervisor.stop();
  process.exitCode = await supervisor.done;
}

function isStopMessage(value: unknown): value is { type: 'stop' } {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'stop';
}

async function waitForSupervisor(): Promise<void> {
  const exitCode = await supervisor.done;
  process.exitCode = exitCode;
}

waitForSupervisor().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
