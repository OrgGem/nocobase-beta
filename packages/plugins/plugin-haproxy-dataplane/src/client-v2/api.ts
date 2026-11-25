// SPDX-License-Identifier: Apache-2.0

import { useMemo } from 'react';
import { useFlowEngine, type FlowEngineContext } from '@nocobase/flow-engine';
import { RESOURCE_NAME } from '../shared/constants';
import type {
  AddRuntimeServerInput,
  BatchSyncItemResult,
  ConfigDiffResult,
  ConfigMutationMeta,
  DataplaneApiInfo,
  DeleteReverseProxyInput,
  HaproxyAclConfig,
  HaproxyAuditLogRecord,
  HaproxyBackendConfig,
  HaproxyBackendSwitchingRule,
  HaproxyBindConfig,
  HaproxyConfigRevisionDetail,
  HaproxyConfigRevisionSummary,
  HaproxyConnectionPublic,
  HaproxyFleetNodeStatus,
  HaproxyFrontendConfig,
  HaproxyHttpRequestRule,
  HaproxyNodeSnapshot,
  HaproxyProcessSummary,
  HaproxyRawConfigResponse,
  HaproxyReload,
  HaproxyRuntimeMapEntry,
  HaproxyRuntimeServer,
  HaproxyServerConfig,
  HaproxySslCertificate,
  HaproxyStickTable,
  HaproxyStickTableEntry,
  HaproxyStorageFile,
  HaproxyTransaction,
  HaproxyUserPermissions,
  ReverseProxyListResponse,
  ToggleReverseProxyInput,
  UpdateRuntimeServerInput,
  UpsertReverseProxyInput,
} from '../shared/types';

interface ApiEnvelope {
  data?: unknown;
}

function unwrap<T>(response: ApiEnvelope): T {
  const outer = response?.data;
  if (outer && typeof outer === 'object' && 'data' in outer) {
    return (outer as { data: T }).data;
  }
  return outer as T;
}

async function callAction<T>(ctx: FlowEngineContext, config: Record<string, unknown>): Promise<T> {
  const res = (await ctx.api.request(config)) as ApiEnvelope;
  return unwrap<T>(res);
}

export interface TestConnectionResponse {
  ok: boolean;
  apiInfo: DataplaneApiInfo;
  processInfo: HaproxyProcessSummary;
}

export interface WriteOptsPayload {
  transactionId?: string;
  version?: number;
  forceReload?: boolean;
}

export interface StorageOptsPayload {
  forceReload?: boolean;
  skipReload?: boolean;
}

export function createHaproxyApi(ctx: FlowEngineContext) {
  return {
    myPermissions: () =>
      callAction<HaproxyUserPermissions>(ctx, {
        url: `${RESOURCE_NAME}:myPermissions`,
        method: 'get',
      }),

    listConnections: () =>
      callAction<HaproxyConnectionPublic[]>(ctx, {
        url: `${RESOURCE_NAME}:listConnections`,
        method: 'get',
      }),

    fleetOverview: () =>
      callAction<HaproxyFleetNodeStatus[]>(ctx, {
        url: `${RESOURCE_NAME}:fleetOverview`,
        method: 'get',
      }),

    listReverseProxies: (connectionId?: number) =>
      callAction<ReverseProxyListResponse>(ctx, {
        url: `${RESOURCE_NAME}:listReverseProxies`,
        method: 'get',
        params: connectionId != null ? { connectionId } : {},
      }),

    upsertReverseProxy: (values: UpsertReverseProxyInput) =>
      callAction<{ frontendName: string; backendName: string; meta: ConfigMutationMeta }>(ctx, {
        url: `${RESOURCE_NAME}:upsertReverseProxy`,
        method: 'post',
        data: { values },
      }),

    toggleReverseProxy: (values: ToggleReverseProxyInput) =>
      callAction<ConfigMutationMeta>(ctx, {
        url: `${RESOURCE_NAME}:toggleReverseProxy`,
        method: 'post',
        data: { values },
      }),

    deleteReverseProxy: (values: DeleteReverseProxyInput) =>
      callAction<ConfigMutationMeta>(ctx, {
        url: `${RESOURCE_NAME}:deleteReverseProxy`,
        method: 'post',
        data: { values },
      }),

    createConnection: (values: Record<string, unknown>) =>
      callAction<HaproxyConnectionPublic>(ctx, {
        url: `${RESOURCE_NAME}:createConnection`,
        method: 'post',
        data: { values },
      }),

    updateConnection: (id: number, values: Record<string, unknown>) =>
      callAction<HaproxyConnectionPublic>(ctx, {
        url: `${RESOURCE_NAME}:updateConnection`,
        method: 'post',
        data: { values: { ...values, id } },
      }),

    deleteConnection: (id: number) =>
      callAction<{ deleted: boolean; id: number }>(ctx, {
        url: `${RESOURCE_NAME}:deleteConnection`,
        method: 'post',
        data: { values: { id } },
      }),

    testConnection: (id: number) =>
      callAction<TestConnectionResponse>(ctx, {
        url: `${RESOURCE_NAME}:testConnection`,
        method: 'post',
        data: { values: { id } },
      }),

    testConnectionDraft: (values: Record<string, unknown>) =>
      callAction<TestConnectionResponse>(ctx, {
        url: `${RESOURCE_NAME}:testConnectionDraft`,
        method: 'post',
        data: { values },
      }),

    // --- Live Snapshot, Runtime Servers, Maps & Stick Tables ---

    getSnapshot: (connectionId: number) =>
      callAction<HaproxyNodeSnapshot>(ctx, {
        url: `${RESOURCE_NAME}:getSnapshot`,
        method: 'get',
        params: { connectionId },
      }),

    updateRuntimeServer: (values: UpdateRuntimeServerInput) =>
      callAction<HaproxyRuntimeServer>(ctx, {
        url: `${RESOURCE_NAME}:updateRuntimeServer`,
        method: 'post',
        data: { values },
      }),

    addRuntimeServer: (values: AddRuntimeServerInput) =>
      callAction<Record<string, unknown>>(ctx, {
        url: `${RESOURCE_NAME}:addRuntimeServer`,
        method: 'post',
        data: { values },
      }),

    deleteRuntimeServer: (connectionId: number, backend: string, server: string) =>
      callAction<{ deleted: boolean }>(ctx, {
        url: `${RESOURCE_NAME}:deleteRuntimeServer`,
        method: 'post',
        data: { values: { connectionId, backend, server } },
      }),

    listRuntimeMaps: (connectionId: number) =>
      callAction<HaproxyStorageFile[]>(ctx, {
        url: `${RESOURCE_NAME}:listRuntimeMaps`,
        method: 'get',
        params: { connectionId },
      }),

    getRuntimeMapEntries: (connectionId: number, map: string) =>
      callAction<HaproxyRuntimeMapEntry[]>(ctx, {
        url: `${RESOURCE_NAME}:getRuntimeMapEntries`,
        method: 'get',
        params: { connectionId, map },
      }),

    addRuntimeMapEntry: (connectionId: number, map: string, key: string, value: string, forceSync = true) =>
      callAction<HaproxyRuntimeMapEntry>(ctx, {
        url: `${RESOURCE_NAME}:addRuntimeMapEntry`,
        method: 'post',
        data: { values: { connectionId, map, key, value, forceSync } },
      }),

    updateRuntimeMapEntry: (connectionId: number, map: string, id: string, value: string, forceSync = true) =>
      callAction<HaproxyRuntimeMapEntry>(ctx, {
        url: `${RESOURCE_NAME}:updateRuntimeMapEntry`,
        method: 'post',
        data: { values: { connectionId, map, id, value, forceSync } },
      }),

    deleteRuntimeMapEntry: (connectionId: number, map: string, id: string, forceSync = true) =>
      callAction<{ deleted: boolean }>(ctx, {
        url: `${RESOURCE_NAME}:deleteRuntimeMapEntry`,
        method: 'post',
        data: { values: { connectionId, map, id, forceSync } },
      }),

    listStickTables: (connectionId: number) =>
      callAction<HaproxyStickTable[]>(ctx, {
        url: `${RESOURCE_NAME}:listStickTables`,
        method: 'get',
        params: { connectionId },
      }),

    getStickTableEntries: (connectionId: number, table: string) =>
      callAction<HaproxyStickTableEntry[]>(ctx, {
        url: `${RESOURCE_NAME}:getStickTableEntries`,
        method: 'get',
        params: { connectionId, table },
      }),

    // --- Transactions & Reloads ---

    getConfigVersion: (connectionId: number, transactionId?: string) =>
      callAction<{ version: number }>(ctx, {
        url: `${RESOURCE_NAME}:getConfigVersion`,
        method: 'get',
        params: { connectionId, ...(transactionId ? { transactionId } : {}) },
      }),

    listTransactions: (connectionId: number, status?: 'in_progress' | 'failed') =>
      callAction<HaproxyTransaction[]>(ctx, {
        url: `${RESOURCE_NAME}:listTransactions`,
        method: 'get',
        params: { connectionId, ...(status ? { status } : {}) },
      }),

    startTransaction: (connectionId: number, version?: number) =>
      callAction<HaproxyTransaction>(ctx, {
        url: `${RESOURCE_NAME}:startTransaction`,
        method: 'post',
        data: { values: { connectionId, ...(version != null ? { version } : {}) } },
      }),

    commitTransaction: (connectionId: number, transactionId: string, forceReload = false) =>
      callAction<{ transaction: HaproxyTransaction | null; meta: ConfigMutationMeta }>(ctx, {
        url: `${RESOURCE_NAME}:commitTransaction`,
        method: 'post',
        data: { values: { connectionId, transactionId, forceReload } },
      }),

    deleteTransaction: (connectionId: number, transactionId: string) =>
      callAction<{ deleted: boolean }>(ctx, {
        url: `${RESOURCE_NAME}:deleteTransaction`,
        method: 'post',
        data: { values: { connectionId, transactionId } },
      }),

    listReloads: (connectionId: number) =>
      callAction<HaproxyReload[]>(ctx, {
        url: `${RESOURCE_NAME}:listReloads`,
        method: 'get',
        params: { connectionId },
      }),

    // --- Phase 1: Revisions, Visual Diff, Live Node Drift, Rollback & Audit Logs ---

    listRevisions: (connectionId?: number) =>
      callAction<HaproxyConfigRevisionSummary[]>(ctx, {
        url: `${RESOURCE_NAME}:listRevisions`,
        method: 'get',
        params: connectionId != null ? { connectionId } : {},
      }),

    getRevision: (revisionId: number) =>
      callAction<HaproxyConfigRevisionDetail>(ctx, {
        url: `${RESOURCE_NAME}:getRevision`,
        method: 'get',
        params: { revisionId },
      }),

    createSnapshot: (connectionId: number, summary?: string) =>
      callAction<HaproxyConfigRevisionSummary | null>(ctx, {
        url: `${RESOURCE_NAME}:createSnapshot`,
        method: 'post',
        data: { values: { connectionId, ...(summary ? { summary } : {}) } },
      }),

    diffRevisions: (leftRevisionId: number, rightRevisionId?: number | 'live', connectionId?: number) =>
      callAction<ConfigDiffResult>(ctx, {
        url: `${RESOURCE_NAME}:diffRevisions`,
        method: 'get',
        params: {
          leftRevisionId,
          ...(rightRevisionId != null ? { rightRevisionId } : {}),
          ...(connectionId != null ? { connectionId } : {}),
        },
      }),

    diffLiveNodes: (leftConnectionId: number, rightConnectionId: number) =>
      callAction<ConfigDiffResult>(ctx, {
        url: `${RESOURCE_NAME}:diffLiveNodes`,
        method: 'get',
        params: { leftConnectionId, rightConnectionId },
      }),

    rollbackRevision: (revisionId: number, opts?: { forceReload?: boolean; skipVersion?: boolean }) =>
      callAction<{ meta: ConfigMutationMeta; revision: HaproxyConfigRevisionSummary | null }>(ctx, {
        url: `${RESOURCE_NAME}:rollbackRevision`,
        method: 'post',
        data: { values: { revisionId, ...opts } },
      }),

    listAuditLogs: (opts?: { connectionId?: number; category?: string }) =>
      callAction<HaproxyAuditLogRecord[]>(ctx, {
        url: `${RESOURCE_NAME}:listAuditLogs`,
        method: 'get',
        params: {
          ...(opts?.connectionId != null ? { connectionId: opts.connectionId } : {}),
          ...(opts?.category ? { category: opts.category } : {}),
        },
      }),

    // --- Raw haproxy.cfg & Batch Sync ---

    getRawConfig: (connectionId: number, transactionId?: string) =>
      callAction<HaproxyRawConfigResponse>(ctx, {
        url: `${RESOURCE_NAME}:getRawConfig`,
        method: 'get',
        params: { connectionId, ...(transactionId ? { transactionId } : {}) },
      }),

    pushRawConfig: (
      connectionId: number,
      content: string,
      opts?: { version?: number; forceReload?: boolean; skipVersion?: boolean },
    ) =>
      callAction<ConfigMutationMeta>(ctx, {
        url: `${RESOURCE_NAME}:pushRawConfig`,
        method: 'post',
        data: { values: { connectionId, content, ...opts } },
      }),

    pushRawConfigBatch: (
      targetConnectionIds: number[],
      content: string,
      opts?: { forceReload?: boolean; skipVersion?: boolean },
    ) =>
      callAction<{ results: BatchSyncItemResult[] }>(ctx, {
        url: `${RESOURCE_NAME}:pushRawConfigBatch`,
        method: 'post',
        data: { values: { targetConnectionIds, content, ...opts } },
      }),

    // --- Structured Configuration ---

    listFrontends: (connectionId: number, transactionId?: string) =>
      callAction<HaproxyFrontendConfig[]>(ctx, {
        url: `${RESOURCE_NAME}:listFrontends`,
        method: 'get',
        params: { connectionId, ...(transactionId ? { transactionId } : {}) },
      }),

    createFrontend: (connectionId: number, frontend: HaproxyFrontendConfig, opts?: WriteOptsPayload) =>
      callAction<{ data: HaproxyFrontendConfig; meta: ConfigMutationMeta }>(ctx, {
        url: `${RESOURCE_NAME}:createFrontend`,
        method: 'post',
        data: { values: { connectionId, frontend, ...opts } },
      }),

    updateFrontend: (connectionId: number, name: string, frontend: HaproxyFrontendConfig, opts?: WriteOptsPayload) =>
      callAction<{ data: HaproxyFrontendConfig; meta: ConfigMutationMeta }>(ctx, {
        url: `${RESOURCE_NAME}:updateFrontend`,
        method: 'post',
        data: { values: { connectionId, name, frontend, ...opts } },
      }),

    deleteFrontend: (connectionId: number, name: string, opts?: WriteOptsPayload) =>
      callAction<ConfigMutationMeta>(ctx, {
        url: `${RESOURCE_NAME}:deleteFrontend`,
        method: 'post',
        data: { values: { connectionId, name, ...opts } },
      }),

    listBinds: (connectionId: number, frontend: string, transactionId?: string) =>
      callAction<HaproxyBindConfig[]>(ctx, {
        url: `${RESOURCE_NAME}:listBinds`,
        method: 'get',
        params: { connectionId, frontend, ...(transactionId ? { transactionId } : {}) },
      }),

    createBind: (connectionId: number, frontend: string, bind: HaproxyBindConfig, opts?: WriteOptsPayload) =>
      callAction<{ data: HaproxyBindConfig; meta: ConfigMutationMeta }>(ctx, {
        url: `${RESOURCE_NAME}:createBind`,
        method: 'post',
        data: { values: { connectionId, frontend, bind, ...opts } },
      }),

    updateBind: (
      connectionId: number,
      frontend: string,
      name: string,
      bind: HaproxyBindConfig,
      opts?: WriteOptsPayload,
    ) =>
      callAction<{ data: HaproxyBindConfig; meta: ConfigMutationMeta }>(ctx, {
        url: `${RESOURCE_NAME}:updateBind`,
        method: 'post',
        data: { values: { connectionId, frontend, name, bind, ...opts } },
      }),

    deleteBind: (connectionId: number, frontend: string, name: string, opts?: WriteOptsPayload) =>
      callAction<ConfigMutationMeta>(ctx, {
        url: `${RESOURCE_NAME}:deleteBind`,
        method: 'post',
        data: { values: { connectionId, frontend, name, ...opts } },
      }),

    listFrontendAcls: (connectionId: number, frontend: string, transactionId?: string) =>
      callAction<HaproxyAclConfig[]>(ctx, {
        url: `${RESOURCE_NAME}:listFrontendAcls`,
        method: 'get',
        params: { connectionId, frontend, ...(transactionId ? { transactionId } : {}) },
      }),

    replaceFrontendAcls: (connectionId: number, frontend: string, acls: HaproxyAclConfig[], opts?: WriteOptsPayload) =>
      callAction<{ data: HaproxyAclConfig[]; meta: ConfigMutationMeta }>(ctx, {
        url: `${RESOURCE_NAME}:replaceFrontendAcls`,
        method: 'post',
        data: { values: { connectionId, frontend, acls, ...opts } },
      }),

    listBackendSwitchingRules: (connectionId: number, frontend: string, transactionId?: string) =>
      callAction<HaproxyBackendSwitchingRule[]>(ctx, {
        url: `${RESOURCE_NAME}:listBackendSwitchingRules`,
        method: 'get',
        params: { connectionId, frontend, ...(transactionId ? { transactionId } : {}) },
      }),

    replaceBackendSwitchingRules: (
      connectionId: number,
      frontend: string,
      rules: HaproxyBackendSwitchingRule[],
      opts?: WriteOptsPayload,
    ) =>
      callAction<{ data: HaproxyBackendSwitchingRule[]; meta: ConfigMutationMeta }>(ctx, {
        url: `${RESOURCE_NAME}:replaceBackendSwitchingRules`,
        method: 'post',
        data: { values: { connectionId, frontend, rules, ...opts } },
      }),

    listFrontendHttpRequestRules: (connectionId: number, frontend: string, transactionId?: string) =>
      callAction<HaproxyHttpRequestRule[]>(ctx, {
        url: `${RESOURCE_NAME}:listFrontendHttpRequestRules`,
        method: 'get',
        params: { connectionId, frontend, ...(transactionId ? { transactionId } : {}) },
      }),

    replaceFrontendHttpRequestRules: (
      connectionId: number,
      frontend: string,
      rules: HaproxyHttpRequestRule[],
      opts?: WriteOptsPayload,
    ) =>
      callAction<{ data: HaproxyHttpRequestRule[]; meta: ConfigMutationMeta }>(ctx, {
        url: `${RESOURCE_NAME}:replaceFrontendHttpRequestRules`,
        method: 'post',
        data: { values: { connectionId, frontend, rules, ...opts } },
      }),

    listBackends: (connectionId: number, transactionId?: string) =>
      callAction<HaproxyBackendConfig[]>(ctx, {
        url: `${RESOURCE_NAME}:listBackends`,
        method: 'get',
        params: { connectionId, ...(transactionId ? { transactionId } : {}) },
      }),

    createBackend: (connectionId: number, backend: HaproxyBackendConfig, opts?: WriteOptsPayload) =>
      callAction<{ data: HaproxyBackendConfig; meta: ConfigMutationMeta }>(ctx, {
        url: `${RESOURCE_NAME}:createBackend`,
        method: 'post',
        data: { values: { connectionId, backend, ...opts } },
      }),

    updateBackend: (connectionId: number, name: string, backend: HaproxyBackendConfig, opts?: WriteOptsPayload) =>
      callAction<{ data: HaproxyBackendConfig; meta: ConfigMutationMeta }>(ctx, {
        url: `${RESOURCE_NAME}:updateBackend`,
        method: 'post',
        data: { values: { connectionId, name, backend, ...opts } },
      }),

    deleteBackend: (connectionId: number, name: string, opts?: WriteOptsPayload) =>
      callAction<ConfigMutationMeta>(ctx, {
        url: `${RESOURCE_NAME}:deleteBackend`,
        method: 'post',
        data: { values: { connectionId, name, ...opts } },
      }),

    listBackendServers: (connectionId: number, backend: string, transactionId?: string) =>
      callAction<HaproxyServerConfig[]>(ctx, {
        url: `${RESOURCE_NAME}:listBackendServers`,
        method: 'get',
        params: { connectionId, backend, ...(transactionId ? { transactionId } : {}) },
      }),

    createBackendServer: (
      connectionId: number,
      backend: string,
      server: HaproxyServerConfig,
      opts?: WriteOptsPayload,
    ) =>
      callAction<{ data: HaproxyServerConfig; meta: ConfigMutationMeta }>(ctx, {
        url: `${RESOURCE_NAME}:createBackendServer`,
        method: 'post',
        data: { values: { connectionId, backend, server, ...opts } },
      }),

    updateBackendServer: (
      connectionId: number,
      backend: string,
      name: string,
      server: HaproxyServerConfig,
      opts?: WriteOptsPayload,
    ) =>
      callAction<{ data: HaproxyServerConfig; meta: ConfigMutationMeta }>(ctx, {
        url: `${RESOURCE_NAME}:updateBackendServer`,
        method: 'post',
        data: { values: { connectionId, backend, name, server, ...opts } },
      }),

    deleteBackendServer: (connectionId: number, backend: string, name: string, opts?: WriteOptsPayload) =>
      callAction<ConfigMutationMeta>(ctx, {
        url: `${RESOURCE_NAME}:deleteBackendServer`,
        method: 'post',
        data: { values: { connectionId, backend, name, ...opts } },
      }),

    // --- Managed Storage (SSL Certificates, Maps, General Files) ---

    listSslCertificates: (connectionId: number) =>
      callAction<HaproxySslCertificate[]>(ctx, {
        url: `${RESOURCE_NAME}:listSslCertificates`,
        method: 'get',
        params: { connectionId },
      }),

    uploadSslCertificate: (connectionId: number, fileName: string, pemContent: string, opts?: StorageOptsPayload) =>
      callAction<{ cert: HaproxySslCertificate | null; meta: ConfigMutationMeta }>(ctx, {
        url: `${RESOURCE_NAME}:uploadSslCertificate`,
        method: 'post',
        data: { values: { connectionId, fileName, pemContent, ...opts } },
      }),

    replaceSslCertificate: (connectionId: number, storageName: string, pemContent: string, opts?: StorageOptsPayload) =>
      callAction<{ cert: HaproxySslCertificate | null; meta: ConfigMutationMeta }>(ctx, {
        url: `${RESOURCE_NAME}:replaceSslCertificate`,
        method: 'post',
        data: { values: { connectionId, storageName, pemContent, ...opts } },
      }),

    deleteSslCertificate: (connectionId: number, storageName: string, opts?: StorageOptsPayload) =>
      callAction<ConfigMutationMeta>(ctx, {
        url: `${RESOURCE_NAME}:deleteSslCertificate`,
        method: 'post',
        data: { values: { connectionId, storageName, ...opts } },
      }),

    syncSslCertificateBatch: (
      targetConnectionIds: number[],
      fileName: string,
      pemContent: string,
      opts?: StorageOptsPayload,
    ) =>
      callAction<{ results: BatchSyncItemResult[] }>(ctx, {
        url: `${RESOURCE_NAME}:syncSslCertificateBatch`,
        method: 'post',
        data: { values: { targetConnectionIds, fileName, pemContent, ...opts } },
      }),

    listStorageMaps: (connectionId: number) =>
      callAction<HaproxyStorageFile[]>(ctx, {
        url: `${RESOURCE_NAME}:listStorageMaps`,
        method: 'get',
        params: { connectionId },
      }),

    getStorageMapContent: (connectionId: number, storageName: string) =>
      callAction<{ storageName: string; content: string }>(ctx, {
        url: `${RESOURCE_NAME}:getStorageMapContent`,
        method: 'get',
        params: { connectionId, storageName },
      }),

    createStorageMap: (connectionId: number, fileName: string, content: string) =>
      callAction<HaproxyStorageFile | null>(ctx, {
        url: `${RESOURCE_NAME}:createStorageMap`,
        method: 'post',
        data: { values: { connectionId, fileName, content } },
      }),

    replaceStorageMap: (connectionId: number, storageName: string, content: string, opts?: StorageOptsPayload) =>
      callAction<ConfigMutationMeta>(ctx, {
        url: `${RESOURCE_NAME}:replaceStorageMap`,
        method: 'post',
        data: { values: { connectionId, storageName, content, ...opts } },
      }),

    deleteStorageMap: (connectionId: number, storageName: string) =>
      callAction<{ deleted: boolean }>(ctx, {
        url: `${RESOURCE_NAME}:deleteStorageMap`,
        method: 'post',
        data: { values: { connectionId, storageName } },
      }),

    listStorageGeneralFiles: (connectionId: number) =>
      callAction<HaproxyStorageFile[]>(ctx, {
        url: `${RESOURCE_NAME}:listStorageGeneralFiles`,
        method: 'get',
        params: { connectionId },
      }),

    getStorageGeneralFileContent: (connectionId: number, storageName: string) =>
      callAction<{ storageName: string; content: string }>(ctx, {
        url: `${RESOURCE_NAME}:getStorageGeneralFileContent`,
        method: 'get',
        params: { connectionId, storageName },
      }),

    createStorageGeneralFile: (connectionId: number, fileName: string, content: string) =>
      callAction<HaproxyStorageFile | null>(ctx, {
        url: `${RESOURCE_NAME}:createStorageGeneralFile`,
        method: 'post',
        data: { values: { connectionId, fileName, content } },
      }),

    replaceStorageGeneralFile: (
      connectionId: number,
      storageName: string,
      content: string,
      opts?: StorageOptsPayload,
    ) =>
      callAction<ConfigMutationMeta>(ctx, {
        url: `${RESOURCE_NAME}:replaceStorageGeneralFile`,
        method: 'post',
        data: { values: { connectionId, storageName, content, ...opts } },
      }),

    deleteStorageGeneralFile: (connectionId: number, storageName: string) =>
      callAction<{ deleted: boolean }>(ctx, {
        url: `${RESOURCE_NAME}:deleteStorageGeneralFile`,
        method: 'post',
        data: { values: { connectionId, storageName } },
      }),
  };
}

export function useHaproxyApi() {
  const engine = useFlowEngine();
  return useMemo(() => createHaproxyApi(engine.context), [engine.context]);
}
