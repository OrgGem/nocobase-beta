/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { JOURNAL_SCHEMA_VERSION, type GuardianState, type RetryRequest, type StartupIncident } from './contracts';
import { isStartupIncident } from './security';
import { writeJsonFileAtomic } from './storage';
import { getProcessLockIdentity, withLocalLock } from './local-lock';

export const MAX_INCIDENT_COUNT = 100;

export function getStateDirectory(appId?: string): string {
  const configured = process.env.STARTUP_GUARDIAN_STATE_DIR;
  const storagePath = process.env.STORAGE_PATH || 'storage';
  const deploymentId = process.env.STARTUP_GUARDIAN_DEPLOYMENT_ID || 'single-node';
  const resolvedAppId = appId || process.env.STARTUP_GUARDIAN_APP_ID || process.env.APP_NAME || 'main';
  const expectedAppId = process.env.STARTUP_GUARDIAN_APP_ID;
  if (expectedAppId && expectedAppId !== resolvedAppId) {
    throw new Error(`Startup Guardian supports only app identity ${expectedAppId} in this process`);
  }
  const base = configured
    ? resolve(configured)
    : resolve(storagePath, '.startup-guardian', toPathSegment(resolvedAppId), toPathSegment(deploymentId));
  if (process.env.STARTUP_GUARDIAN_CLUSTER_MODE !== 'redis-postgres') return base;
  if (process.env.STARTUP_GUARDIAN_STATE_SCOPE === 'node') return base;
  const nodeId = process.env.STARTUP_GUARDIAN_NODE_ID || '';
  const safeNodeId = toPathSegment(nodeId);
  if (basename(base) === safeNodeId && basename(resolve(base, '..')) === 'nodes') return base;
  return resolve(base, 'nodes', safeNodeId);
}

export function getJournalDirectory(stateDirectory = getStateDirectory()): string {
  return join(stateDirectory, 'events');
}

export async function writeIncident(incident: StartupIncident, stateDirectory = getStateDirectory()): Promise<void> {
  if (!isStartupIncident(incident)) throw new Error('Invalid startup incident');
  const directory = getJournalDirectory(stateDirectory);
  await writeJsonFileAtomic(join(directory, `${incident.eventId}.json`), incident);
  const names = await readdir(directory);
  const incidentNames = names.filter((name) => name.endsWith('.json'));
  if (incidentNames.length <= MAX_INCIDENT_COUNT) return;
  const files = await readIncidentFiles(directory);
  const staleFiles = files.slice(0, files.length - MAX_INCIDENT_COUNT);
  await Promise.all(staleFiles.map(({ fileName }) => rm(join(directory, fileName), { force: true })));
}

export async function readIncidents(stateDirectory = getStateDirectory()): Promise<StartupIncident[]> {
  const files = await readIncidentFiles(getJournalDirectory(stateDirectory));
  return files.map(({ incident }) => incident);
}

async function readIncidentFiles(directory: string): Promise<Array<{ fileName: string; incident: StartupIncident }>> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }

  const incidents: Array<{ fileName: string; incident: StartupIncident }> = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const raw = await readFile(join(directory, name), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isStartupIncident(parsed)) throw new Error(`Invalid startup incident file: ${name}`);
    incidents.push({ fileName: name, incident: parsed });
  }
  return incidents.sort((left, right) => left.incident.timestamp.localeCompare(right.incident.timestamp));
}

export function createInitialState(input: { appId: string; deploymentId: string; campaignId?: string }): GuardianState {
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    revision: 0,
    campaignId: input.campaignId || randomUUID(),
    appId: input.appId,
    deploymentId: input.deploymentId,
    state: 'stopped',
    quarantineAttempts: 0,
    maxQuarantineAttempts: 2,
    updatedAt: new Date().toISOString(),
  };
}

export async function readState(stateDirectory = getStateDirectory()): Promise<GuardianState | null> {
  try {
    const raw = await readFile(join(stateDirectory, 'state.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isGuardianState(parsed)) throw new Error('Startup Guardian state has an unsupported or invalid schema');
    return parsed;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

export async function writeState(state: GuardianState, stateDirectory = getStateDirectory()): Promise<void> {
  if (!isGuardianState(state)) throw new Error('Invalid Startup Guardian state');
  await withLocalLock(stateDirectory, 'state-write.lock', getProcessLockIdentity(), () =>
    writeJsonFileAtomic(join(stateDirectory, 'state.json'), state),
  );
}

export async function writeRetryRequest(request: RetryRequest, stateDirectory = getStateDirectory()): Promise<void> {
  await writeJsonFileAtomic(join(stateDirectory, 'retry-request.json'), request);
}

export async function readRetryRequest(stateDirectory = getStateDirectory()): Promise<RetryRequest | null> {
  try {
    const raw = await readFile(join(stateDirectory, 'retry-request.json'), 'utf8');
    const value: unknown = JSON.parse(raw);
    if (!isRetryRequest(value)) throw new Error('Invalid Startup Guardian retry request');
    return value;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

export async function clearRetryRequest(stateDirectory = getStateDirectory()): Promise<void> {
  await rm(join(stateDirectory, 'retry-request.json'), { force: true });
}

export function isGuardianState(value: unknown): value is GuardianState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<GuardianState>;
  return (
    state.schemaVersion === JOURNAL_SCHEMA_VERSION &&
    typeof state.revision === 'number' &&
    typeof state.campaignId === 'string' &&
    typeof state.appId === 'string' &&
    typeof state.deploymentId === 'string' &&
    ['stopped', 'starting', 'ready', 'recovery-required'].includes(String(state.state)) &&
    typeof state.quarantineAttempts === 'number' &&
    typeof state.maxQuarantineAttempts === 'number' &&
    typeof state.updatedAt === 'string' &&
    (state.incident === undefined || isStartupIncident(state.incident)) &&
    (state.quarantine === undefined || isQuarantineReceipt(state.quarantine)) &&
    (state.quarantinePending === undefined || isPendingQuarantine(state.quarantinePending))
  );
}

function isPendingQuarantine(value: unknown): value is NonNullable<GuardianState['quarantinePending']> {
  if (!value || typeof value !== 'object') return false;
  const pending = value as Partial<NonNullable<GuardianState['quarantinePending']>>;
  return (
    isStartupIncident(pending.incident) &&
    !!pending.target &&
    typeof pending.target.pluginName === 'string' &&
    typeof pending.target.packageName === 'string' &&
    typeof pending.target.pluginVersion === 'string' &&
    typeof pending.attempt === 'number' &&
    (typeof pending.rowId === 'number' || typeof pending.rowId === 'string') &&
    !!pending.prior &&
    typeof pending.prior.version === 'string' &&
    typeof pending.prior.enabled === 'boolean' &&
    typeof pending.prior.installed === 'boolean' &&
    typeof pending.prior.builtIn === 'boolean' &&
    typeof pending.prior.updatedAt === 'string'
  );
}

export function isQuarantineReceipt(value: unknown): value is NonNullable<GuardianState['quarantine']> {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<NonNullable<GuardianState['quarantine']>>;
  return (
    typeof receipt.quarantineId === 'string' &&
    ['quarantined', 'retry-pending', 'retrying', 're-quarantined', 'cleared', 'retry-failed'].includes(
      String(receipt.status),
    ) &&
    isStartupIncident(receipt.incident) &&
    !!receipt.target &&
    typeof receipt.target.pluginName === 'string' &&
    typeof receipt.target.packageName === 'string' &&
    typeof receipt.target.pluginVersion === 'string' &&
    (typeof receipt.rowId === 'string' || typeof receipt.rowId === 'number') &&
    typeof receipt.postUpdateTimestamp === 'string' &&
    !!receipt.prior &&
    typeof receipt.prior.version === 'string' &&
    typeof receipt.prior.enabled === 'boolean' &&
    typeof receipt.prior.installed === 'boolean' &&
    typeof receipt.prior.builtIn === 'boolean' &&
    typeof receipt.prior.updatedAt === 'string' &&
    typeof receipt.quarantinedAt === 'string'
  );
}

function isRetryRequest(value: unknown): value is RetryRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<RetryRequest>;
  return (
    request.schemaVersion === JOURNAL_SCHEMA_VERSION &&
    typeof request.requestId === 'string' &&
    typeof request.packageName === 'string' &&
    typeof request.expectedRevision === 'number' &&
    typeof request.requestedBy === 'string' &&
    typeof request.requestedAt === 'string'
  );
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function toPathSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(value))
    throw new Error('Startup Guardian app identity contains unsupported path characters');
  return value;
}

export async function updateState(
  update: (current: GuardianState) => GuardianState,
  stateDirectory = getStateDirectory(),
): Promise<GuardianState> {
  const current =
    (await readState(stateDirectory)) ??
    createInitialState({
      appId: process.env.STARTUP_GUARDIAN_APP_ID || process.env.APP_NAME || 'main',
      deploymentId: process.env.STARTUP_GUARDIAN_DEPLOYMENT_ID || 'single-node',
    });
  const next = update(current);
  const value = { ...next, revision: current.revision + 1, updatedAt: new Date().toISOString() };
  await writeState(value, stateDirectory);
  return value;
}
