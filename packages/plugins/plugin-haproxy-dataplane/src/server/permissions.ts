// SPDX-License-Identifier: Apache-2.0

import { HAPROXY_SNIPPETS, RESOURCE_NAME } from '../shared/constants';
import type { HaproxyUserPermissions } from '../shared/types';

export const HAPROXY_ACTIONS = {
  read: [
    `${RESOURCE_NAME}:myPermissions`,
    `${RESOURCE_NAME}:listConnections`,
    `${RESOURCE_NAME}:fleetOverview`,
    `${RESOURCE_NAME}:listReverseProxies`,
    `${RESOURCE_NAME}:getSnapshot`,
    `${RESOURCE_NAME}:listRuntimeMaps`,
    `${RESOURCE_NAME}:getRuntimeMapEntries`,
    `${RESOURCE_NAME}:listStickTables`,
    `${RESOURCE_NAME}:getStickTableEntries`,
    `${RESOURCE_NAME}:getConfigVersion`,
    `${RESOURCE_NAME}:listTransactions`,
    `${RESOURCE_NAME}:listReloads`,
    `${RESOURCE_NAME}:listRevisions`,
    `${RESOURCE_NAME}:getRevision`,
    `${RESOURCE_NAME}:diffRevisions`,
    `${RESOURCE_NAME}:diffLiveNodes`,
    `${RESOURCE_NAME}:listAuditLogs`,
    `${RESOURCE_NAME}:getRawConfig`,
    `${RESOURCE_NAME}:listFrontends`,
    `${RESOURCE_NAME}:listBinds`,
    `${RESOURCE_NAME}:listFrontendAcls`,
    `${RESOURCE_NAME}:listBackendSwitchingRules`,
    `${RESOURCE_NAME}:listFrontendHttpRequestRules`,
    `${RESOURCE_NAME}:listBackends`,
    `${RESOURCE_NAME}:listBackendServers`,
    `${RESOURCE_NAME}:listSslCertificates`,
    `${RESOURCE_NAME}:listStorageMaps`,
    `${RESOURCE_NAME}:getStorageMapContent`,
    `${RESOURCE_NAME}:listStorageGeneralFiles`,
    `${RESOURCE_NAME}:getStorageGeneralFileContent`,
  ],
  runtime: [
    `${RESOURCE_NAME}:listConnections`,
    `${RESOURCE_NAME}:getSnapshot`,
    `${RESOURCE_NAME}:listRuntimeMaps`,
    `${RESOURCE_NAME}:getRuntimeMapEntries`,
    `${RESOURCE_NAME}:listStickTables`,
    `${RESOURCE_NAME}:getStickTableEntries`,
    `${RESOURCE_NAME}:updateRuntimeServer`,
    `${RESOURCE_NAME}:addRuntimeServer`,
    `${RESOURCE_NAME}:deleteRuntimeServer`,
    `${RESOURCE_NAME}:addRuntimeMapEntry`,
    `${RESOURCE_NAME}:updateRuntimeMapEntry`,
    `${RESOURCE_NAME}:deleteRuntimeMapEntry`,
  ],
  config: [
    `${RESOURCE_NAME}:listConnections`,
    `${RESOURCE_NAME}:listReverseProxies`,
    `${RESOURCE_NAME}:upsertReverseProxy`,
    `${RESOURCE_NAME}:toggleReverseProxy`,
    `${RESOURCE_NAME}:deleteReverseProxy`,
    `${RESOURCE_NAME}:getConfigVersion`,
    `${RESOURCE_NAME}:listTransactions`,
    `${RESOURCE_NAME}:listReloads`,
    `${RESOURCE_NAME}:listRevisions`,
    `${RESOURCE_NAME}:getRevision`,
    `${RESOURCE_NAME}:diffRevisions`,
    `${RESOURCE_NAME}:diffLiveNodes`,
    `${RESOURCE_NAME}:listAuditLogs`,
    `${RESOURCE_NAME}:createSnapshot`,
    `${RESOURCE_NAME}:startTransaction`,
    `${RESOURCE_NAME}:commitTransaction`,
    `${RESOURCE_NAME}:deleteTransaction`,
    `${RESOURCE_NAME}:listFrontends`,
    `${RESOURCE_NAME}:createFrontend`,
    `${RESOURCE_NAME}:updateFrontend`,
    `${RESOURCE_NAME}:deleteFrontend`,
    `${RESOURCE_NAME}:listBinds`,
    `${RESOURCE_NAME}:createBind`,
    `${RESOURCE_NAME}:updateBind`,
    `${RESOURCE_NAME}:deleteBind`,
    `${RESOURCE_NAME}:listFrontendAcls`,
    `${RESOURCE_NAME}:replaceFrontendAcls`,
    `${RESOURCE_NAME}:listBackendSwitchingRules`,
    `${RESOURCE_NAME}:replaceBackendSwitchingRules`,
    `${RESOURCE_NAME}:listFrontendHttpRequestRules`,
    `${RESOURCE_NAME}:replaceFrontendHttpRequestRules`,
    `${RESOURCE_NAME}:listBackends`,
    `${RESOURCE_NAME}:createBackend`,
    `${RESOURCE_NAME}:updateBackend`,
    `${RESOURCE_NAME}:deleteBackend`,
    `${RESOURCE_NAME}:listBackendServers`,
    `${RESOURCE_NAME}:createBackendServer`,
    `${RESOURCE_NAME}:updateBackendServer`,
    `${RESOURCE_NAME}:deleteBackendServer`,
  ],
  rawConfig: [
    `${RESOURCE_NAME}:listConnections`,
    `${RESOURCE_NAME}:getConfigVersion`,
    `${RESOURCE_NAME}:getRawConfig`,
    `${RESOURCE_NAME}:listRevisions`,
    `${RESOURCE_NAME}:getRevision`,
    `${RESOURCE_NAME}:diffRevisions`,
    `${RESOURCE_NAME}:diffLiveNodes`,
    `${RESOURCE_NAME}:listAuditLogs`,
    `${RESOURCE_NAME}:createSnapshot`,
    `${RESOURCE_NAME}:rollbackRevision`,
    `${RESOURCE_NAME}:pushRawConfig`,
    `${RESOURCE_NAME}:pushRawConfigBatch`,
  ],
  storage: [
    `${RESOURCE_NAME}:listConnections`,
    `${RESOURCE_NAME}:listSslCertificates`,
    `${RESOURCE_NAME}:uploadSslCertificate`,
    `${RESOURCE_NAME}:replaceSslCertificate`,
    `${RESOURCE_NAME}:deleteSslCertificate`,
    `${RESOURCE_NAME}:syncSslCertificateBatch`,
    `${RESOURCE_NAME}:listStorageMaps`,
    `${RESOURCE_NAME}:getStorageMapContent`,
    `${RESOURCE_NAME}:createStorageMap`,
    `${RESOURCE_NAME}:replaceStorageMap`,
    `${RESOURCE_NAME}:deleteStorageMap`,
    `${RESOURCE_NAME}:listStorageGeneralFiles`,
    `${RESOURCE_NAME}:getStorageGeneralFileContent`,
    `${RESOURCE_NAME}:createStorageGeneralFile`,
    `${RESOURCE_NAME}:replaceStorageGeneralFile`,
    `${RESOURCE_NAME}:deleteStorageGeneralFile`,
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

export const HAPROXY_MANAGE_ACTIONS = [...new Set(Object.values(HAPROXY_ACTIONS).flat())];

export const HAPROXY_SNIPPET_ACTION_MAP: ReadonlyArray<{ name: string; actions: string[] }> = [
  { name: HAPROXY_SNIPPETS.access, actions: [] },
  { name: HAPROXY_SNIPPETS.read, actions: [...HAPROXY_ACTIONS.read] },
  { name: HAPROXY_SNIPPETS.runtime, actions: [...HAPROXY_ACTIONS.runtime] },
  { name: HAPROXY_SNIPPETS.config, actions: [...HAPROXY_ACTIONS.config] },
  { name: HAPROXY_SNIPPETS.rawConfig, actions: [...HAPROXY_ACTIONS.rawConfig] },
  { name: HAPROXY_SNIPPETS.storage, actions: [...HAPROXY_ACTIONS.storage] },
  { name: HAPROXY_SNIPPETS.connections, actions: [...HAPROXY_ACTIONS.connections] },
  { name: HAPROXY_SNIPPETS.manage, actions: [...HAPROXY_MANAGE_ACTIONS] },
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

export function resolveContextPermissions(ctx: PermissionCheckContext): HaproxyUserPermissions {
  const canRead = canPerform(ctx, 'getSnapshot');
  const canRuntime = canPerform(ctx, 'updateRuntimeServer');
  const canConfig = canPerform(ctx, 'createFrontend');
  const canRawConfig = canPerform(ctx, 'pushRawConfig');
  const canStorage = canPerform(ctx, 'uploadSslCertificate');
  const canManageConnections = canPerform(ctx, 'createConnection');
  const canManage = canRead && canRuntime && canConfig && canRawConfig && canStorage && canManageConnections;

  return {
    canAccess: canRead || canRuntime || canConfig || canRawConfig || canStorage || canManageConnections,
    canRead,
    canRuntime,
    canConfig,
    canRawConfig,
    canStorage,
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
