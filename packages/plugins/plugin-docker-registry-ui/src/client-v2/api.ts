import type { FlowEngineContext } from '@nocobase/flow-engine';
import type {
  NormalizedManifest,
  PublicRegistrySettings,
  RegistryDeleteImpact,
  RegistryListResult,
  RegistryRepositoryDeleteImpact,
  RegistryRepositoryDeleteResult,
  RegistrySettingsInput,
  RegistryArchiveFormat,
  RegistryTransferResult,
  SafeRegistrySettings,
} from '../shared/types';

interface ApiEnvelope {
  data?: unknown;
}

interface RegistryHealth {
  reachable: boolean;
  authentication: 'public' | 'required' | 'failed';
  apiVersion?: string;
  manifestAccept: string[];
}

function unwrap<T>(response: ApiEnvelope): T {
  const outer = response.data;
  if (typeof outer === 'object' && outer !== null && 'data' in outer) {
    return (outer as { data: T }).data;
  }
  return outer as T;
}

async function request<T>(ctx: FlowEngineContext, config: Record<string, unknown>): Promise<T> {
  const response = (await ctx.api.request(config)) as ApiEnvelope;
  return unwrap<T>(response);
}

export function buildApiActionUrl(baseUrl: string, origin: string, action: string): URL {
  const url = new URL(baseUrl, origin);
  const basePath = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  url.pathname = `${basePath}${action}`;
  url.search = '';
  url.hash = '';
  return url;
}

export const registryApi = {
  getSettings: (ctx: FlowEngineContext) =>
    request<SafeRegistrySettings>(ctx, { url: 'dockerRegistry:getSettings', method: 'get' }),
  getPublicSettings: (ctx: FlowEngineContext) =>
    request<PublicRegistrySettings>(ctx, { url: 'dockerRegistry:getPublicConfiguration', method: 'get' }),
  updateSettings: (ctx: FlowEngineContext, values: RegistrySettingsInput) =>
    request<SafeRegistrySettings>(ctx, { url: 'dockerRegistry:updateSettings', method: 'post', data: { values } }),
  testConnection: (ctx: FlowEngineContext) =>
    request<RegistryHealth>(ctx, { url: 'dockerRegistry:testConnection', method: 'get' }),
  testConnectionDraft: (ctx: FlowEngineContext, values: RegistrySettingsInput) =>
    request<RegistryHealth>(ctx, {
      url: 'dockerRegistry:testConnectionDraft',
      method: 'post',
      data: { values },
    }),
  listRepositories: (ctx: FlowEngineContext, cursor?: string, search?: string) =>
    request<RegistryListResult>(ctx, {
      url: 'dockerRegistry:listRepositories',
      method: 'get',
      params: { cursor, search },
    }),
  listTags: (ctx: FlowEngineContext, repository: string, cursor?: string, search?: string) =>
    request<RegistryListResult>(ctx, {
      url: 'dockerRegistry:listTags',
      method: 'get',
      params: { repository, cursor, search },
    }),
  getImageDetails: (ctx: FlowEngineContext, repository: string, reference: string) =>
    request<NormalizedManifest>(ctx, {
      url: 'dockerRegistry:getImageDetails',
      method: 'get',
      params: { repository, reference },
    }),
  getDeleteImpact: (ctx: FlowEngineContext, repository: string, tag: string) =>
    request<RegistryDeleteImpact>(ctx, {
      url: 'dockerRegistry:getDeleteImpact',
      method: 'get',
      params: { repository, tag },
    }),
  deleteTag: (
    ctx: FlowEngineContext,
    repository: string,
    tag: string,
    expectedDigest: string,
    confirmSharedDigest: boolean,
  ) =>
    request<RegistryDeleteImpact>(ctx, {
      url: 'dockerRegistry:deleteTag',
      method: 'post',
      data: { values: { repository, tag, expectedDigest, confirmSharedDigest } },
    }),
  getRepositoryDeleteImpact: (ctx: FlowEngineContext, repository: string) =>
    request<RegistryRepositoryDeleteImpact>(ctx, {
      url: 'dockerRegistry:getRepositoryDeleteImpact',
      method: 'get',
      params: { repository },
    }),
  deleteRepositoryContents: (
    ctx: FlowEngineContext,
    repository: string,
    expectedSignature: string,
    confirmRepository: boolean,
  ) =>
    request<RegistryRepositoryDeleteResult>(ctx, {
      url: 'dockerRegistry:deleteRepositoryContents',
      method: 'post',
      data: { values: { repository, expectedSignature, confirmRepository } },
    }),
  uploadImage: (ctx: FlowEngineContext, file: File, repository: string, tag: string, format: RegistryArchiveFormat) =>
    request<RegistryTransferResult>(ctx, {
      url: 'dockerRegistry:uploadImage',
      method: 'post',
      params: { ...(repository ? { repository } : {}), ...(tag ? { tag } : {}), format },
      headers: { 'Content-Type': 'application/x-tar' },
      data: file,
      timeout: 0,
    }),
  downloadImage: async (
    ctx: FlowEngineContext,
    repository: string,
    reference: string,
    format: RegistryArchiveFormat,
  ) => {
    const baseUrl = ctx.api.axios.defaults.baseURL ?? '/api/';
    const url = buildApiActionUrl(baseUrl, window.location.origin, 'dockerRegistry:downloadImage');
    url.searchParams.set('repository', repository);
    url.searchParams.set('reference', reference);
    url.searchParams.set('format', format);
    const response = await fetch(url, { headers: ctx.api.getHeaders() });
    if (!response.ok) {
      let message = `Download failed with HTTP ${response.status}`;
      try {
        const payload = (await response.json()) as {
          errors?: Array<{ message?: string }>;
          error?: { message?: string };
        };
        message = payload.errors?.[0]?.message ?? payload.error?.message ?? message;
      } catch {
        // Keep the HTTP status when the response is not JSON.
      }
      throw new Error(message);
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const filename =
      disposition.match(/filename="?([^";]+)"?/i)?.[1] ??
      `${repository.replace(/\//g, '-')}-${reference}.${format}.tar`;
    const picker = (
      window as unknown as {
        showSaveFilePicker?: (options: {
          suggestedName: string;
          types: Array<{ description: string; accept: Record<string, string[]> }>;
        }) => Promise<{
          createWritable(): Promise<{
            write(data: Uint8Array): Promise<void>;
            close(): Promise<void>;
            abort(): Promise<void>;
          }>;
        }>;
      }
    ).showSaveFilePicker;
    if (picker && response.body) {
      const handle = await picker({
        suggestedName: filename,
        types: [{ description: 'Tar archive', accept: { 'application/x-tar': ['.tar'] } }],
      });
      const writable = await handle.createWritable();
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writable.write(value);
        }
        await writable.close();
      } catch (error) {
        await writable.abort();
        throw error;
      }
      return filename;
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
    return filename;
  },
};

export type { RegistryHealth };
