// SPDX-License-Identifier: Apache-2.0

import { useMemo } from 'react';
import { useFlowEngine, type FlowEngineContext } from '@nocobase/flow-engine';
import { RESOURCE_NAME } from '../shared/constants';
import { resolveSignedDownloadUrl } from '../shared/signed-url';
import type {
  RcloneAboutUsage,
  RcloneConnectionPublic,
  RcloneCoreStats,
  RcloneDiskInfo,
  RcloneListItem,
  RcloneMountPoint,
  RcloneProviderInfo,
  RcloneRemoteSummary,
  RcloneRuntimeOptionsSummary,
  RcloneServeItem,
  RcloneTransferOperation,
  RcloneTransferTaskRecord,
  RcloneUserPermissions,
  RcloneVersionInfo,
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

export function resolveFullSignedUrl(ctx: FlowEngineContext, signedRelativePath: string): string {
  const baseUrl = ctx.api?.axios?.defaults?.baseURL ?? '/api/';
  return resolveSignedDownloadUrl(baseUrl, window.location.origin, signedRelativePath);
}

export interface DashboardSummaryResponse {
  version: RcloneVersionInfo;
  stats: RcloneCoreStats;
  remotes: RcloneRemoteSummary[];
  mountsCount: number;
  servesCount: number;
  activeTasksCount: number;
  checkUsageOnLoad: boolean;
}

export function createRcloneApi(ctx: FlowEngineContext) {
  return {
    myPermissions: () =>
      callAction<RcloneUserPermissions>(ctx, { url: `${RESOURCE_NAME}:myPermissions`, method: 'get' }),

    listConnections: () =>
      callAction<RcloneConnectionPublic[]>(ctx, { url: `${RESOURCE_NAME}:listConnections`, method: 'get' }),

    createConnection: (values: Record<string, unknown>) =>
      callAction<RcloneConnectionPublic>(ctx, {
        url: `${RESOURCE_NAME}:createConnection`,
        method: 'post',
        data: { values },
      }),

    updateConnection: (id: number, values: Record<string, unknown>) =>
      callAction<RcloneConnectionPublic>(ctx, {
        url: `${RESOURCE_NAME}:updateConnection`,
        method: 'post',
        data: { values: { ...values, id } },
      }),

    deleteConnection: (id: number) =>
      callAction<{ deleted: boolean }>(ctx, {
        url: `${RESOURCE_NAME}:deleteConnection`,
        method: 'post',
        data: { values: { id } },
      }),

    testConnection: (id: number) =>
      callAction<{ ok: boolean; version: RcloneVersionInfo }>(ctx, {
        url: `${RESOURCE_NAME}:testConnection`,
        method: 'post',
        data: { values: { id } },
      }),

    testConnectionDraft: (values: Record<string, unknown>) =>
      callAction<{ ok: boolean; version: RcloneVersionInfo }>(ctx, {
        url: `${RESOURCE_NAME}:testConnectionDraft`,
        method: 'post',
        data: { values },
      }),

    dashboardSummary: (connectionId: number) =>
      callAction<DashboardSummaryResponse>(ctx, {
        url: `${RESOURCE_NAME}:dashboardSummary`,
        method: 'get',
        params: { connectionId },
      }),

    remoteUsage: (connectionId: number, fs: string) =>
      callAction<RcloneAboutUsage>(ctx, {
        url: `${RESOURCE_NAME}:remoteUsage`,
        method: 'get',
        params: { connectionId, fs },
      }),

    listProviders: (connectionId: number) =>
      callAction<RcloneProviderInfo[]>(ctx, {
        url: `${RESOURCE_NAME}:listProviders`,
        method: 'get',
        params: { connectionId },
      }),

    listRemotes: (connectionId: number) =>
      callAction<RcloneRemoteSummary[]>(ctx, {
        url: `${RESOURCE_NAME}:listRemotes`,
        method: 'get',
        params: { connectionId },
      }),

    getRemoteConfig: (connectionId: number, name: string) =>
      callAction<Record<string, unknown>>(ctx, {
        url: `${RESOURCE_NAME}:getRemoteConfig`,
        method: 'get',
        params: { connectionId, name },
      }),

    createRemote: (connectionId: number, name: string, type: string, parameters: Record<string, unknown>) =>
      callAction<{ created: boolean; name: string }>(ctx, {
        url: `${RESOURCE_NAME}:createRemote`,
        method: 'post',
        data: { values: { connectionId, name, type, parameters } },
      }),

    updateRemote: (connectionId: number, name: string, parameters: Record<string, unknown>) =>
      callAction<{ updated: boolean; name: string }>(ctx, {
        url: `${RESOURCE_NAME}:updateRemote`,
        method: 'post',
        data: { values: { connectionId, name, parameters } },
      }),

    deleteRemote: (connectionId: number, name: string) =>
      callAction<{ deleted: boolean; name: string }>(ctx, {
        url: `${RESOURCE_NAME}:deleteRemote`,
        method: 'post',
        data: { values: { connectionId, name } },
      }),

    listDisks: (connectionId: number) =>
      callAction<RcloneDiskInfo[]>(ctx, {
        url: `${RESOURCE_NAME}:listDisks`,
        method: 'get',
        params: { connectionId },
      }),

    listFiles: (connectionId: number, fs: string, remote: string) =>
      callAction<RcloneListItem[]>(ctx, {
        url: `${RESOURCE_NAME}:listFiles`,
        method: 'get',
        params: { connectionId, fs, remote },
      }),

    mkdir: (connectionId: number, fs: string, remote: string) =>
      callAction<{ ok: boolean }>(ctx, {
        url: `${RESOURCE_NAME}:mkdir`,
        method: 'post',
        data: { values: { connectionId, fs, remote } },
      }),

    deleteItem: (connectionId: number, fs: string, remote: string, isDir: boolean) =>
      callAction<{ ok: boolean }>(ctx, {
        url: `${RESOURCE_NAME}:deleteItem`,
        method: 'post',
        data: { values: { connectionId, fs, remote, isDir } },
      }),

    renameItem: (connectionId: number, fs: string, srcRemote: string, dstRemote: string, isDir: boolean) =>
      callAction<{ ok: boolean }>(ctx, {
        url: `${RESOURCE_NAME}:renameItem`,
        method: 'post',
        data: { values: { connectionId, fs, srcRemote, dstRemote, isDir } },
      }),

    uploadFile: (connectionId: number, fs: string, remote: string, file: File) => {
      const formData = new FormData();
      formData.append('file', file, file.name);
      return callAction<{ ok: boolean }>(ctx, {
        url: `${RESOURCE_NAME}:uploadFile`,
        method: 'post',
        params: { connectionId, fs, remote },
        data: formData,
        timeout: 0,
      });
    },

    signDownload: async (
      connectionId: number,
      fs: string,
      remote: string,
      isDir: boolean,
      mode: 'inline' | 'attachment' = 'attachment',
    ) => {
      const signed = await callAction<{ url: string }>(ctx, {
        url: `${RESOURCE_NAME}:signDownload`,
        method: 'post',
        data: { values: { connectionId, fs, remote, isDir, mode } },
      });
      return resolveFullSignedUrl(ctx, signed.url);
    },

    triggerTransferWorkflow: (values: {
      connectionId: number;
      operation: RcloneTransferOperation;
      srcFs: string;
      srcRemote?: string;
      dstFs: string;
      dstRemote?: string;
      createEmptySrcDirs?: boolean;
      deleteEmptySrcDirs?: boolean;
      dryRun?: boolean;
      filterRules?: Record<string, unknown> | null;
    }) =>
      callAction<RcloneTransferTaskRecord>(ctx, {
        url: `${RESOURCE_NAME}:triggerTransferWorkflow`,
        method: 'post',
        data: { values },
      }),

    listJobs: (connectionId?: number) =>
      callAction<RcloneTransferTaskRecord[]>(ctx, {
        url: `${RESOURCE_NAME}:listJobs`,
        method: 'get',
        params: connectionId ? { connectionId } : {},
      }),

    stopJob: (taskId: number) =>
      callAction<{ stopped: boolean; status?: string }>(ctx, {
        url: `${RESOURCE_NAME}:stopJob`,
        method: 'post',
        data: { values: { taskId } },
      }),

    listMountTypes: (connectionId: number) =>
      callAction<string[]>(ctx, {
        url: `${RESOURCE_NAME}:listMountTypes`,
        method: 'get',
        params: { connectionId },
      }),

    listMounts: (connectionId: number) =>
      callAction<RcloneMountPoint[]>(ctx, {
        url: `${RESOURCE_NAME}:listMounts`,
        method: 'get',
        params: { connectionId },
      }),

    createMount: (values: Record<string, unknown>) =>
      callAction<{ ok: boolean }>(ctx, {
        url: `${RESOURCE_NAME}:createMount`,
        method: 'post',
        data: { values },
      }),

    unmount: (connectionId: number, mountPoint: string) =>
      callAction<{ ok: boolean }>(ctx, {
        url: `${RESOURCE_NAME}:unmount`,
        method: 'post',
        data: { values: { connectionId, mountPoint } },
      }),

    unmountAll: (connectionId: number) =>
      callAction<{ ok: boolean }>(ctx, {
        url: `${RESOURCE_NAME}:unmountAll`,
        method: 'post',
        data: { values: { connectionId } },
      }),

    listServeTypes: (connectionId: number) =>
      callAction<string[]>(ctx, {
        url: `${RESOURCE_NAME}:listServeTypes`,
        method: 'get',
        params: { connectionId },
      }),

    listServes: (connectionId: number) =>
      callAction<RcloneServeItem[]>(ctx, {
        url: `${RESOURCE_NAME}:listServes`,
        method: 'get',
        params: { connectionId },
      }),

    startServe: (values: Record<string, unknown>) =>
      callAction<{ id: string; addr: string }>(ctx, {
        url: `${RESOURCE_NAME}:startServe`,
        method: 'post',
        data: { values },
      }),

    stopServe: (connectionId: number, id: string) =>
      callAction<{ ok: boolean }>(ctx, {
        url: `${RESOURCE_NAME}:stopServe`,
        method: 'post',
        data: { values: { connectionId, id } },
      }),

    stopAllServes: (connectionId: number) =>
      callAction<{ ok: boolean }>(ctx, {
        url: `${RESOURCE_NAME}:stopAllServes`,
        method: 'post',
        data: { values: { connectionId } },
      }),

    getRuntimeOptions: (connectionId: number) =>
      callAction<{ options: RcloneRuntimeOptionsSummary; paths: { config?: string; cache?: string; temp?: string } }>(
        ctx,
        {
          url: `${RESOURCE_NAME}:getRuntimeOptions`,
          method: 'get',
          params: { connectionId },
        },
      ),

    setRuntimeOptions: (values: Record<string, unknown>) =>
      callAction<{ ok: boolean }>(ctx, {
        url: `${RESOURCE_NAME}:setRuntimeOptions`,
        method: 'post',
        data: { values },
      }),

    getRawConfig: (connectionId: number) =>
      callAction<{ path: string; content: string; configDisabled?: boolean }>(ctx, {
        url: `${RESOURCE_NAME}:getRawConfig`,
        method: 'get',
        params: { connectionId },
      }),

    saveRawConfig: (connectionId: number, content: string) =>
      callAction<{ path: string }>(ctx, {
        url: `${RESOURCE_NAME}:saveRawConfig`,
        method: 'post',
        data: { values: { connectionId, content } },
      }),
  };
}

export function useRcloneApi() {
  const engine = useFlowEngine();
  return useMemo(() => createRcloneApi(engine.context), [engine.context]);
}
