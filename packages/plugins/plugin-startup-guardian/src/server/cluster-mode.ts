/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';

export const STARTUP_GUARDIAN_CLUSTER_MODE = 'redis-postgres' as const;
export const STARTUP_GUARDIAN_CLUSTER_PROTOCOL_VERSION = 1;
export const CLUSTER_LOCK_TTL_MS = 30_000;
export const CLUSTER_DATABASE_LEASE_MS = 10_000;
export const CLUSTER_HEARTBEAT_INTERVAL_MS = 1_000;
export const CLUSTER_POLL_INTERVAL_MS = 250;
export const CLUSTER_DRAIN_TIMEOUT_MS = 60_000;

export interface ClusterModeConfig {
  appId: string;
  deploymentId: string;
  nodeId: string;
  members: string[];
  redisUrl: string;
  registryRedisUrl: string;
}

export interface ClusterManagerNodeRecord {
  id: string;
  workerMode: string;
  appRole?: string;
  isSandbox: boolean;
}

export interface ClusterLockLease {
  ownerToken: string;
  verify(): Promise<boolean>;
  renew(): Promise<boolean>;
  release(): Promise<boolean>;
}

interface ClusterLockClient {
  apiVersion: 1;
  tryAcquire(ownerToken?: string): Promise<ClusterLockLease | null>;
  listClusterManagerNodes(): Promise<ClusterManagerNodeRecord[]>;
  close(): Promise<void>;
}

interface ClusterLockOptions {
  appName: string;
  lockName: string;
  redisUrl?: string;
  registryRedisUrl?: string;
  ttlMs?: number;
}

const runtimeRequire = createRequire(join(process.cwd(), 'package.json'));

export function isClusterModeEnabled(): boolean {
  return process.env.STARTUP_GUARDIAN_CLUSTER_MODE === STARTUP_GUARDIAN_CLUSTER_MODE;
}

export function readClusterModeConfig(): ClusterModeConfig | null {
  if (!isClusterModeEnabled()) return null;
  const appId = process.env.STARTUP_GUARDIAN_APP_ID || process.env.APP_NAME || 'main';
  const deploymentId = process.env.STARTUP_GUARDIAN_DEPLOYMENT_ID || '';
  const nodeId = process.env.STARTUP_GUARDIAN_NODE_ID || '';
  const appRole = process.env.APP_ROLE || 'app';
  const workerMode = (process.env.WORKER_MODE || 'main').trim().toLowerCase();
  const membersValue = process.env.STARTUP_GUARDIAN_CLUSTER_MEMBERS || '';
  const redisUrl = process.env.LOCK_ADAPTER_REDIS_URL || process.env.REDIS_URL || '';
  const registryRedisUrl =
    process.env.NODE_REGISTRY_REDIS_URL ||
    process.env.CLUSTER_MANAGER_REDIS_URL ||
    process.env.REDIS_URL ||
    process.env.CACHE_REDIS_URL ||
    process.env.PUBSUB_ADAPTER_REDIS_URL ||
    process.env.QUEUE_ADAPTER_REDIS_URL ||
    process.env.LOCK_ADAPTER_REDIS_URL ||
    '';
  for (const [name, value] of Object.entries({ appId, deploymentId, nodeId })) assertSafeIdentifier(value, name);
  if (appRole !== 'app' || process.env.SKILL_HUB_SANDBOX === 'true' || !['', 'main', 'app', '!'].includes(workerMode)) {
    throw new Error('HA auto-recovery only supports app-serving nodes without worker or sandbox roles');
  }
  if (process.env.STARTUP_GUARDIAN_CLUSTER_NO_WORKERS !== 'true') {
    throw new Error('Set STARTUP_GUARDIAN_CLUSTER_NO_WORKERS=true only after excluding all shared-database workers');
  }
  const members = membersValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (members.length === 0) throw new Error('STARTUP_GUARDIAN_CLUSTER_MEMBERS must list every app node identity');
  for (const member of members) assertSafeIdentifier(member, 'cluster member');
  const uniqueMembers = [...new Set(members)].sort();
  if (uniqueMembers.length !== members.length) throw new Error('STARTUP_GUARDIAN_CLUSTER_MEMBERS contains duplicates');
  if (!uniqueMembers.includes(nodeId))
    throw new Error('STARTUP_GUARDIAN_NODE_ID must appear in the cluster member list');
  if (!redisUrl) throw new Error('LOCK_ADAPTER_REDIS_URL or REDIS_URL is required for Guardian cluster mode');
  if (!registryRedisUrl)
    throw new Error('Cluster Manager node registry Redis URL is required for Guardian cluster mode');
  return { appId, deploymentId, nodeId, members: uniqueMembers, redisUrl, registryRedisUrl };
}

export function loadClusterLockApi(): {
  version: 1;
  createClient: (options: ClusterLockOptions) => ClusterLockClient;
} {
  const loaded: unknown = runtimeRequire('plugin-cluster-manager/recovery');
  if (!loaded || typeof loaded !== 'object') throw new Error('Cluster Manager recovery lock API is unavailable');
  const module = loaded as {
    STARTUP_RECOVERY_LOCK_API_VERSION?: unknown;
    createStartupRecoveryLockClient?: unknown;
  };
  if (module.STARTUP_RECOVERY_LOCK_API_VERSION !== 1 || typeof module.createStartupRecoveryLockClient !== 'function') {
    throw new Error('Cluster Manager recovery lock API version 1 is required');
  }
  return {
    version: 1,
    createClient: module.createStartupRecoveryLockClient as (options: ClusterLockOptions) => ClusterLockClient,
  };
}

function assertSafeIdentifier(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value)) {
    throw new Error(`${name} must be a non-empty identifier using letters, digits, dot, underscore, or hyphen`);
  }
}
