// SPDX-License-Identifier: Apache-2.0

import type { Context } from '@nocobase/actions';
import { RCLONE_SNIPPETS, RESOURCE_NAME } from '../shared/constants';
import { isConnectionStringOverride, isLocalFsTarget } from '../shared/fs-guard';
import type { RcloneFsLocality, RcloneUserPermissions } from '../shared/types';

export const RCLONE_ACTIONS = {
  read: [
    `${RESOURCE_NAME}:myPermissions`,
    `${RESOURCE_NAME}:listConnections`,
    `${RESOURCE_NAME}:dashboardSummary`,
    `${RESOURCE_NAME}:remoteUsage`,
    `${RESOURCE_NAME}:listRemotes`,
    `${RESOURCE_NAME}:listProviders`,
    `${RESOURCE_NAME}:listFiles`,
    `${RESOURCE_NAME}:listJobs`,
  ],
  transfer: [
    `${RESOURCE_NAME}:mkdir`,
    `${RESOURCE_NAME}:deleteItem`,
    `${RESOURCE_NAME}:renameItem`,
    `${RESOURCE_NAME}:uploadFile`,
    `${RESOURCE_NAME}:signDownload`,
    `${RESOURCE_NAME}:triggerTransferWorkflow`,
    `${RESOURCE_NAME}:stopJob`,
  ],
  remotes: [
    `${RESOURCE_NAME}:listProviders`,
    `${RESOURCE_NAME}:getRemoteConfig`,
    `${RESOURCE_NAME}:createRemote`,
    `${RESOURCE_NAME}:updateRemote`,
    `${RESOURCE_NAME}:deleteRemote`,
  ],
  localFs: [`${RESOURCE_NAME}:listDisks`],
  mounts: [
    `${RESOURCE_NAME}:listConnections`,
    `${RESOURCE_NAME}:listRemotes`,
    `${RESOURCE_NAME}:listMountTypes`,
    `${RESOURCE_NAME}:listMounts`,
    `${RESOURCE_NAME}:createMount`,
    `${RESOURCE_NAME}:unmount`,
    `${RESOURCE_NAME}:unmountAll`,
  ],
  serves: [
    `${RESOURCE_NAME}:listConnections`,
    `${RESOURCE_NAME}:listRemotes`,
    `${RESOURCE_NAME}:listServeTypes`,
    `${RESOURCE_NAME}:listServes`,
    `${RESOURCE_NAME}:startServe`,
    `${RESOURCE_NAME}:stopServe`,
    `${RESOURCE_NAME}:stopAllServes`,
  ],
  rawConfig: [
    `${RESOURCE_NAME}:listConnections`,
    `${RESOURCE_NAME}:getRuntimeOptions`,
    `${RESOURCE_NAME}:setRuntimeOptions`,
    `${RESOURCE_NAME}:getRawConfig`,
    `${RESOURCE_NAME}:saveRawConfig`,
  ],
  connections: [
    `${RESOURCE_NAME}:listConnections`,
    `${RESOURCE_NAME}:createConnection`,
    `${RESOURCE_NAME}:updateConnection`,
    `${RESOURCE_NAME}:deleteConnection`,
    `${RESOURCE_NAME}:testConnection`,
    `${RESOURCE_NAME}:testConnectionDraft`,
  ],
} as const;

export const RCLONE_MANAGE_ACTIONS = [...new Set(Object.values(RCLONE_ACTIONS).flat())];

export const RCLONE_SNIPPET_ACTION_MAP: ReadonlyArray<{ name: string; actions: string[] }> = [
  { name: RCLONE_SNIPPETS.access, actions: [] },
  { name: RCLONE_SNIPPETS.read, actions: [...RCLONE_ACTIONS.read] },
  { name: RCLONE_SNIPPETS.transfer, actions: [...RCLONE_ACTIONS.transfer] },
  { name: RCLONE_SNIPPETS.remotes, actions: [...RCLONE_ACTIONS.remotes] },
  { name: RCLONE_SNIPPETS.localFs, actions: [...RCLONE_ACTIONS.localFs] },
  { name: RCLONE_SNIPPETS.mounts, actions: [...RCLONE_ACTIONS.mounts] },
  { name: RCLONE_SNIPPETS.serves, actions: [...RCLONE_ACTIONS.serves] },
  { name: RCLONE_SNIPPETS.rawConfig, actions: [...RCLONE_ACTIONS.rawConfig] },
  { name: RCLONE_SNIPPETS.connections, actions: [...RCLONE_ACTIONS.connections] },
  { name: RCLONE_SNIPPETS.manage, actions: [...RCLONE_MANAGE_ACTIONS] },
  { name: RCLONE_SNIPPETS.legacyManage, actions: [...RCLONE_MANAGE_ACTIONS] },
];

export interface PermissionCheckContext {
  state?: {
    currentRole?: string;
    currentRoles?: string[];
  };
  can?: (args: { resource: string; action: string }) => { params?: Record<string, unknown> } | boolean | null;
}

function canPerform(ctx: PermissionCheckContext, action: string): boolean {
  const roles = ctx.state?.currentRoles ?? (ctx.state?.currentRole ? [ctx.state.currentRole] : []);
  if (roles.includes('root')) {
    return true;
  }
  return Boolean(ctx.can?.({ resource: RESOURCE_NAME, action }));
}

export function resolveContextPermissions(ctx: PermissionCheckContext): RcloneUserPermissions {
  const canRead = canPerform(ctx, 'dashboardSummary');
  const canTransfer = canPerform(ctx, 'triggerTransferWorkflow');
  const canManageRemotes = canPerform(ctx, 'createRemote');
  const canLocalFs = canPerform(ctx, 'listDisks');
  const canMounts = canPerform(ctx, 'createMount');
  const canServes = canPerform(ctx, 'startServe');
  const canRawConfig = canPerform(ctx, 'saveRawConfig');
  const canManageConnections = canPerform(ctx, 'createConnection');
  const canManage =
    canRead &&
    canTransfer &&
    canManageRemotes &&
    canLocalFs &&
    canMounts &&
    canServes &&
    canRawConfig &&
    canManageConnections;

  return {
    canAccess:
      canRead ||
      canTransfer ||
      canManageRemotes ||
      canLocalFs ||
      canMounts ||
      canServes ||
      canRawConfig ||
      canManageConnections,
    canRead,
    canTransfer,
    canManageRemotes,
    canLocalFs,
    canMounts,
    canServes,
    canRawConfig,
    canManageConnections,
    canManage,
  };
}

export function hasEnvironmentPermission(ctx?: PermissionCheckContext): boolean {
  const roles = ctx?.state?.currentRoles ?? (ctx?.state?.currentRole ? [ctx.state.currentRole] : []);
  if (roles.includes('root')) {
    return true;
  }
  const permission = ctx?.can?.({ resource: 'environmentVariables', action: 'update' });
  if (!permission || typeof permission === 'boolean') {
    return Boolean(permission);
  }
  return Object.keys(permission.params || {}).length === 0;
}

export function assertLocalFsPermitted(
  ctx: Context,
  fsList: readonly string[],
  remoteTypes?: Readonly<Record<string, string>>,
): void {
  const touchesLocal = fsList.some((fs) => isLocalFsTarget(fs, remoteTypes));
  if (!touchesLocal) {
    return;
  }
  const perms = resolveContextPermissions(ctx as unknown as PermissionCheckContext);
  if (!perms.canLocalFs) {
    ctx.throw(403, 'High-privilege permission "local-fs" is required to access host local disks');
  }
}

export async function assertFsTargetsPermitted(
  ctx: Context,
  client: {
    classifyFsLocality?: (fs: string) => Promise<RcloneFsLocality>;
    isFsLocal: (fs: string) => Promise<boolean>;
  },
  fsList: readonly string[],
): Promise<void> {
  const perms = resolveContextPermissions(ctx as unknown as PermissionCheckContext);
  for (const fs of fsList) {
    if (isConnectionStringOverride(fs) && !(perms.canRawConfig && perms.canLocalFs)) {
      ctx.throw(
        403,
        'On-the-fly Rclone connection strings and parameter overrides require both raw-config and local-fs permissions',
      );
    }
  }
  if (perms.canLocalFs) {
    return;
  }
  for (const fs of fsList) {
    if (typeof client.classifyFsLocality === 'function') {
      const locality = await client.classifyFsLocality(fs);
      if (locality === 'local') {
        ctx.throw(403, 'High-privilege permission "local-fs" is required to access host local disks');
      }
      if (locality === 'unknown') {
        ctx.throw(403, `Unable to classify remote "${fs}"; operation denied until remote type can be verified`);
      }
      continue;
    }
    if (await client.isFsLocal(fs)) {
      ctx.throw(403, 'High-privilege permission "local-fs" is required to access host local disks');
    }
  }
}
