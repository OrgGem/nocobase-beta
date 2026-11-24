// SPDX-License-Identifier: Apache-2.0

import { Transform } from 'node:stream';
import type { Context, Next } from '@nocobase/actions';
import type { Model } from '@nocobase/database';
import type WorkflowPlugin from '@nocobase/plugin-workflow';
import { COLLECTIONS, RESOURCE_NAME, SECRET_MASK, TRANSFER_OPERATIONS } from '../../shared/constants';
import {
  extractWrapperTargets,
  isConnectionStringOverride,
  normalizeRemoteSubPath,
  WRAPPER_REMOTE_TYPES,
} from '../../shared/fs-guard';
import type { RcloneRemoteSummary, RcloneRuntimeOptionsSummary, RcloneTransferOperation } from '../../shared/types';
import {
  assertFsTargetsPermitted,
  assertLocalFsPermitted,
  resolveContextPermissions,
  type PermissionCheckContext,
} from '../permissions';
import type PluginRcloneManagerServer from '../plugin';
import { assertValidRcBaseUrl, RcloneRcClient, RcloneRcError } from '../services/rclone-rc-client';
import { maskRemoteConfig, mergeRemoteConfigForUpdate } from '../utils/secret-redactor';
import { isLockContentionError, runWithAppLock, type LockableAppLike } from '../utils/distributed-lock';
import {
  buildContentDisposition,
  createSignedDownloadQuery,
  verifyStreamSignature,
  type RcloneSignedStreamPayload,
} from '../utils/url-signing';
import { ensureDefaultExplorerWorkflow } from '../workflow/default-workflow';

const DEFAULT_MAX_UPLOAD_MB = 2048;

function getMaxUploadBytes(): number {
  const configured = Number(process.env.RCLONE_MAX_UPLOAD_MB ?? DEFAULT_MAX_UPLOAD_MB);
  const safeMb = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_UPLOAD_MB;
  return Math.floor(safeMb * 1024 * 1024);
}

function getParamRecord(ctx: Context): Record<string, unknown> {
  const params = (ctx.action?.params ?? {}) as Record<string, unknown>;
  let values =
    params.values && typeof params.values === 'object' && !Array.isArray(params.values)
      ? (params.values as Record<string, unknown>)
      : {};
  if (values.values && typeof values.values === 'object' && !Array.isArray(values.values)) {
    values = { ...values, ...(values.values as Record<string, unknown>) };
  }
  return { ...params, ...values };
}

function extractDaemonJobError(output: unknown, directError?: string): string {
  if (directError && directError.trim()) {
    return directError.trim();
  }
  if (!output || typeof output !== 'object' || !('results' in output)) {
    return '';
  }
  const results = (output as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return '';
  }
  const messages: string[] = [];
  for (const item of results) {
    if (item && typeof item === 'object' && 'error' in item) {
      const msg = String((item as { error?: unknown }).error ?? '').trim();
      if (msg) {
        messages.push(msg);
      }
    }
  }
  return messages.join('\n');
}

function isCancellationJobError(errorText: string): boolean {
  const normalized = errorText.trim();
  if (!normalized) {
    return true;
  }
  return /context cancel(?:ed|led)|job.*(?:stopped|cancel(?:ed|led))|stopped by user|operation cancel(?:ed|led)|interrupted/i.test(
    normalized,
  );
}

function rethrowRcError(ctx: Context, error: unknown): never {
  if (error instanceof RcloneRcError) {
    ctx.throw(error.status >= 400 && error.status < 600 ? error.status : 502, error.message);
  }
  const status = (error as { status?: number } | null)?.status;
  const msg = error instanceof Error ? error.message : String(error);
  ctx.throw(status && status >= 400 && status < 600 ? status : 400, msg);
}

function isTransferOp(value: string): value is RcloneTransferOperation {
  return (TRANSFER_OPERATIONS as readonly string[]).includes(value);
}

function getUrlOrigin(rawUrl: string): string {
  return new URL(assertValidRcBaseUrl(rawUrl)).origin;
}

const ACTIVE_CONTENT_EXT_RE = /\.(?:html?|svgz?|xhtml|xht|xml|xsl|xslt|pdf)$/i;
const ACTIVE_CONTENT_MIME_RE =
  /^(?:text\/html|text\/xml|application\/xhtml\+xml|application\/xml|application\/xslt\+xml|image\/svg\+xml|application\/pdf)\b/i;

export function createRcloneManagerActions(plugin: PluginRcloneManagerServer) {
  const { connectionManager } = plugin;

  return {
    async myPermissions(ctx: Context, next: Next) {
      ctx.body = resolveContextPermissions(ctx as unknown as PermissionCheckContext);
      await next();
    },

    async listConnections(ctx: Context, next: Next) {
      const perms = resolveContextPermissions(ctx as unknown as PermissionCheckContext);
      const repo = plugin.db.getRepository(COLLECTIONS.connections);
      const rows = (await repo.find({
        filter: perms.canManageConnections ? {} : { enabled: true },
        sort: ['id'],
      })) as Model[];
      ctx.body = rows.map((row) => connectionManager.toPublicConnection(row, perms.canManageConnections));
      await next();
    },

    async createConnection(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const name = String(input.name ?? '').trim();
      const baseUrl = String(input.baseUrl ?? '').trim();
      const authType = input.authType === 'none' ? 'none' : 'basic';
      const username = String(input.username ?? '').trim();
      const rawPassword = String(input.password ?? '');

      if (!name || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
        ctx.throw(400, 'Connection name must be 1-64 characters of letters, digits, hyphens, or underscores');
      }

      try {
        connectionManager.assertEnvReferencesPermitted(
          [baseUrl, username, rawPassword],
          ctx as unknown as PermissionCheckContext,
        );
        assertValidRcBaseUrl(connectionManager.resolveEnv(baseUrl, false));

        const encryptedPassword = rawPassword ? await connectionManager.encryptPassword(rawPassword) : null;
        const repo = plugin.db.getRepository(COLLECTIONS.connections);
        const created = await repo.create({
          values: {
            name,
            title: input.title ? String(input.title).trim() : null,
            baseUrl,
            authType,
            username: authType === 'basic' ? username : null,
            password: authType === 'basic' ? encryptedPassword : null,
            enabled: input.enabled !== false,
            checkUsageOnLoad: input.checkUsageOnLoad !== false,
            notes: input.notes ? String(input.notes) : null,
          },
        });
        ctx.body = connectionManager.toPublicConnection(created, true);
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async updateConnection(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const id = Number(input.id ?? input.connectionId ?? input.filterByTk);
      try {
        const model = await connectionManager.getConnectionModel(id, false);
        const nextBaseUrl = input.baseUrl !== undefined ? String(input.baseUrl).trim() : String(model.get('baseUrl'));
        const nextAuthType =
          input.authType !== undefined
            ? input.authType === 'none'
              ? 'none'
              : 'basic'
            : model.get('authType') === 'none'
              ? 'none'
              : 'basic';
        const nextUsername =
          input.username !== undefined ? String(input.username).trim() : String(model.get('username') ?? '');
        const incomingPass = input.password !== undefined ? String(input.password) : SECRET_MASK;

        connectionManager.assertEnvReferencesPermitted(
          [nextBaseUrl, nextUsername, incomingPass === SECRET_MASK ? '' : incomingPass],
          ctx as unknown as PermissionCheckContext,
        );
        const resolvedNextUrl = assertValidRcBaseUrl(connectionManager.resolveEnv(nextBaseUrl, false));
        if (nextAuthType === 'basic' && incomingPass === SECRET_MASK && Boolean(model.get('password'))) {
          const prevResolvedUrl = connectionManager.resolveEnv(String(model.get('baseUrl') ?? ''), false);
          if (getUrlOrigin(resolvedNextUrl) !== getUrlOrigin(prevResolvedUrl)) {
            ctx.throw(400, 'Re-enter password when changing the connection URL origin');
          }
        }

        const patch: Record<string, unknown> = {
          baseUrl: nextBaseUrl,
          authType: nextAuthType,
          username: nextAuthType === 'basic' ? nextUsername : null,
        };
        if (input.name !== undefined) {
          const nextName = String(input.name).trim();
          if (!nextName || !/^[a-zA-Z0-9_-]{1,64}$/.test(nextName)) {
            ctx.throw(400, 'Connection name must be 1-64 characters of letters, digits, hyphens, or underscores');
          }
          patch.name = nextName;
        }
        if (input.title !== undefined) patch.title = input.title ? String(input.title).trim() : null;
        if (input.enabled !== undefined) patch.enabled = Boolean(input.enabled);
        if (input.checkUsageOnLoad !== undefined) patch.checkUsageOnLoad = Boolean(input.checkUsageOnLoad);
        if (input.notes !== undefined) patch.notes = input.notes ? String(input.notes) : null;

        if (nextAuthType === 'none') {
          patch.password = null;
        } else if (incomingPass !== SECRET_MASK) {
          patch.password = incomingPass ? await connectionManager.encryptPassword(incomingPass) : null;
        }

        await model.update(patch);
        connectionManager.invalidate(id);
        ctx.body = connectionManager.toPublicConnection(model, true);
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async deleteConnection(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const id = Number(input.id ?? input.connectionId ?? input.filterByTk);
      try {
        const model = await connectionManager.getConnectionModel(id, false);
        await model.destroy();
        connectionManager.invalidate(id);
        ctx.body = { deleted: true, id };
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async testConnection(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const id = Number(input.id ?? input.connectionId);
      try {
        const { model, client } = await connectionManager.getClient(id, false);
        try {
          const version = await client.testConnection();
          await model.update({
            lastCheckAt: new Date(),
            lastVersion: version.version ?? 'ok',
            lastError: null,
          });
          ctx.body = { ok: true, version };
        } catch (checkError) {
          const message = checkError instanceof Error ? checkError.message : String(checkError);
          await model.update({
            lastCheckAt: new Date(),
            lastError: message,
          });
          throw checkError;
        }
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async testConnectionDraft(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const baseUrl = String(input.baseUrl ?? '').trim();
      const authType = input.authType === 'none' ? 'none' : 'basic';
      const username = String(input.username ?? '').trim();
      let rawPassword = String(input.password ?? '');

      try {
        connectionManager.assertEnvReferencesPermitted(
          [baseUrl, username, rawPassword === SECRET_MASK ? '' : rawPassword],
          ctx as unknown as PermissionCheckContext,
        );
        const resolvedUrl = assertValidRcBaseUrl(connectionManager.resolveEnv(baseUrl, false));

        if (rawPassword === SECRET_MASK && input.id) {
          const existing = await connectionManager.getConnectionModel(Number(input.id), false);
          const existingUrl = connectionManager.resolveEnv(String(existing.get('baseUrl') ?? ''), false);
          if (Boolean(existing.get('password')) && getUrlOrigin(resolvedUrl) !== getUrlOrigin(existingUrl)) {
            ctx.throw(400, 'Re-enter password when testing a different connection URL origin');
          }
          rawPassword = await connectionManager.decryptPassword(existing.get('password') as string | null);
        }

        const draftClient = new RcloneRcClient({
          baseUrl: resolvedUrl,
          authType,
          username: connectionManager.resolveEnv(username, true),
          password: connectionManager.resolveEnv(rawPassword, true),
        });
        const version = await draftClient.testConnection();
        ctx.body = { ok: true, version };
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async dashboardSummary(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const perms = resolveContextPermissions(ctx as unknown as PermissionCheckContext);
      try {
        const { model, client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        const [version, stats, allRemotes, mounts, serves, activeTasksCount] = await Promise.all([
          client.getVersion(),
          client.getStats(),
          client.inspectRemotes(),
          perms.canMounts ? client.listMounts().catch(() => []) : Promise.resolve([]),
          perms.canServes ? client.listServes().catch(() => []) : Promise.resolve([]),
          plugin.db.getRepository(COLLECTIONS.tasks).count({
            filter: {
              connectionId: Number(model.get('id')),
              status: ['queued', 'starting', 'running'],
              ...(!perms.canLocalFs ? { localAuthorized: { $isFalsy: true } } : {}),
            },
          }),
        ]);

        const remotes: RcloneRemoteSummary[] = allRemotes.filter(
          (item) => perms.canLocalFs || (!item.isLocal && item.locality !== 'unknown'),
        );

        await model.update({
          lastCheckAt: new Date(),
          lastVersion: version.version ?? null,
          lastError: null,
        });

        ctx.body = {
          version,
          stats,
          remotes,
          mountsCount: mounts.length,
          servesCount: serves.length,
          activeTasksCount,
          checkUsageOnLoad: model.get('checkUsageOnLoad') !== false,
        };
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async remoteUsage(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const fs = String(input.fs ?? '').trim();
      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        await assertFsTargetsPermitted(ctx, client, [fs]);
        const usage = await client.getAbout(fs);
        ctx.body = usage;
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async listProviders(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const perms = resolveContextPermissions(ctx as unknown as PermissionCheckContext);
      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        const providers = await client.listProviders();
        ctx.body = providers
          .filter((provider) => !provider.Hide && !['uptobox', 'tardigrade'].includes(provider.Name))
          .filter((provider) => perms.canLocalFs || provider.Name.toLowerCase() !== 'local')
          .sort((a, b) => a.Name.localeCompare(b.Name));
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async listRemotes(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const perms = resolveContextPermissions(ctx as unknown as PermissionCheckContext);
      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        const allRemotes = await client.inspectRemotes();
        ctx.body = allRemotes.filter((item) => perms.canLocalFs || (!item.isLocal && item.locality !== 'unknown'));
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async getRemoteConfig(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const name = String(input.name ?? '').trim();
      if (!name) ctx.throw(400, 'Remote name is required');
      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        const [rawConfig, providers] = await Promise.all([client.getRemoteRaw(name), client.listProviders()]);
        const remoteType = String(rawConfig.type ?? '');
        if (remoteType.toLowerCase() === 'local') {
          assertLocalFsPermitted(ctx, [':local:']);
        }
        await assertFsTargetsPermitted(ctx, client, [`${name}:`]);
        const provider = providers.find((item) => item.Name === remoteType);
        ctx.body = maskRemoteConfig(rawConfig, provider?.Options);
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async createRemote(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const name = String(input.name ?? '').trim();
      const type = String(input.type ?? '').trim();
      const parameters =
        input.parameters && typeof input.parameters === 'object' && !Array.isArray(input.parameters)
          ? (input.parameters as Record<string, unknown>)
          : {};

      if (!name || !/^[a-zA-Z0-9._-]{1,64}$/.test(name)) {
        ctx.throw(400, 'Remote name must be 1-64 characters of letters, numbers, dots, hyphens, or underscores');
      }
      if (!type) {
        ctx.throw(400, 'Remote backend type is required');
      }
      if (type.toLowerCase() === 'local') {
        assertLocalFsPermitted(ctx, [':local:']);
      }

      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        const wrapperTargets = extractWrapperTargets(parameters);
        if (WRAPPER_REMOTE_TYPES.has(type.toLowerCase()) && wrapperTargets.length === 0) {
          ctx.throw(400, `Wrapper remote "${type}" requires a non-empty remote or upstreams target`);
        }
        if (wrapperTargets.length > 0) {
          await assertFsTargetsPermitted(ctx, client, wrapperTargets);
        }
        // Lock by remote name across the application so two connections referencing the same rclone daemon via
        // different URLs (e.g. localhost vs 127.0.0.1 or DNS alias) still serialize check-then-create cleanly.
        const createLockKey = `rclone-manager:create-remote:${name.toLowerCase()}`;
        try {
          await runWithAppLock(
            plugin.app as unknown as LockableAppLike,
            createLockKey,
            async () => {
              const existingRemotes = await client.listRemoteNames();
              if (existingRemotes.includes(name)) {
                ctx.throw(409, `Remote "${name}" already exists`);
              }
              await client.createRemote(name, type, parameters, { nonInteractive: true });
            },
            { timeoutMs: 15_000, ttlMs: 35_000 },
          );
        } catch (lockErr) {
          if (isLockContentionError(lockErr)) {
            ctx.throw(409, `Another request is already creating remote "${name}"`);
          }
          throw lockErr;
        }
        ctx.body = { created: true, name, type };
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async updateRemote(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const name = String(input.name ?? '').trim();
      const incomingParams =
        input.parameters && typeof input.parameters === 'object' && !Array.isArray(input.parameters)
          ? (input.parameters as Record<string, unknown>)
          : {};
      if (!name) ctx.throw(400, 'Remote name is required');

      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        const [existingConfig, providers] = await Promise.all([client.getRemoteRaw(name), client.listProviders()]);
        const remoteType = String(existingConfig.type ?? '');
        if (remoteType.toLowerCase() === 'local') {
          assertLocalFsPermitted(ctx, [':local:']);
        }
        if (WRAPPER_REMOTE_TYPES.has(remoteType.toLowerCase())) {
          const clearsTarget = Object.entries(incomingParams).some(([k, v]) => {
            const lower = k.trim().toLowerCase();
            return (
              (lower === 'remote' || lower === 'upstreams') &&
              (v === null || (typeof v === 'string' && v.trim() === ''))
            );
          });
          if (clearsTarget) {
            ctx.throw(400, `Wrapper remote "${remoteType}" cannot clear its remote or upstreams target`);
          }
        }
        await assertFsTargetsPermitted(ctx, client, [`${name}:`, ...extractWrapperTargets(incomingParams)]);
        const provider = providers.find((item) => item.Name === remoteType);
        const merged = mergeRemoteConfigForUpdate(existingConfig, incomingParams, provider?.Options);
        await client.updateRemote(name, merged, { nonInteractive: true });
        ctx.body = { updated: true, name };
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async deleteRemote(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const name = String(input.name ?? '').trim();
      if (!name) ctx.throw(400, 'Remote name is required');
      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        const existingConfig = await client.getRemoteRaw(name);
        if (String(existingConfig.type ?? '').toLowerCase() === 'local') {
          assertLocalFsPermitted(ctx, [':local:']);
        }
        await assertFsTargetsPermitted(ctx, client, [`${name}:`]);
        await client.deleteRemote(name);
        ctx.body = { deleted: true, name };
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async listDisks(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        ctx.body = await client.listDisks();
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async listFiles(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const fs = String(input.fs ?? '').trim();
      if (!fs) ctx.throw(400, 'fs is required');
      try {
        const remote = normalizeRemoteSubPath(String(input.remote ?? ''));
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        await assertFsTargetsPermitted(ctx, client, [fs]);
        const list = await client.listFiles(fs, remote);
        ctx.body = list;
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async mkdir(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const fs = String(input.fs ?? '').trim();
      try {
        const remote = normalizeRemoteSubPath(String(input.remote ?? ''));
        if (!fs || !remote) ctx.throw(400, 'fs and directory path are required');
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        await assertFsTargetsPermitted(ctx, client, [fs]);
        await client.mkdir(fs, remote);
        ctx.body = { ok: true };
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async deleteItem(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const fs = String(input.fs ?? '').trim();
      const isDir = Boolean(input.isDir);
      try {
        const remote = normalizeRemoteSubPath(String(input.remote ?? ''));
        if (!fs || !remote) ctx.throw(400, 'fs and target path are required');
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        await assertFsTargetsPermitted(ctx, client, [fs]);
        if (isDir) {
          await client.purgeDir(fs, remote);
        } else {
          await client.deleteFile(fs, remote);
        }
        ctx.body = { ok: true };
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async renameItem(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const fs = String(input.fs ?? '').trim();
      const isDir = Boolean(input.isDir);
      try {
        const srcRemote = normalizeRemoteSubPath(String(input.srcRemote ?? ''));
        const dstRemote = normalizeRemoteSubPath(String(input.dstRemote ?? ''));
        if (!fs || !srcRemote || !dstRemote) {
          ctx.throw(400, 'fs, srcRemote, and dstRemote are required');
        }
        if (srcRemote === dstRemote) {
          ctx.body = { ok: true };
          await next();
          return;
        }
        const srcParent = srcRemote.includes('/') ? srcRemote.slice(0, srcRemote.lastIndexOf('/')) : '';
        const dstParent = dstRemote.includes('/') ? dstRemote.slice(0, dstRemote.lastIndexOf('/')) : '';
        if (srcParent !== dstParent) {
          ctx.throw(
            400,
            'Cross-directory move must be executed via triggerTransferWorkflow so it runs through NocoBase Workflow',
          );
        }

        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        await assertFsTargetsPermitted(ctx, client, [fs]);

        const existingDest = await client.statItem(fs, dstRemote);
        if (existingDest) {
          ctx.throw(409, `Destination "${dstRemote}" already exists`);
        }

        if (isDir) {
          const joinFs = (sub: string) =>
            fs.endsWith(':') || fs.endsWith('/') || fs.endsWith('\\') ? `${fs}${sub}` : `${fs}/${sub}`;
          await client.moveDirSync(joinFs(srcRemote), joinFs(dstRemote));
        } else {
          await client.moveFileSync(fs, srcRemote, fs, dstRemote);
        }
        ctx.body = { ok: true };
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async uploadFile(ctx: Context, next: Next) {
      const query = ctx.request.query as Record<string, string | string[] | undefined>;
      const connectionId = String(query.connectionId ?? ctx.action?.params?.connectionId ?? '');
      const fs = String(query.fs ?? ctx.action?.params?.fs ?? '').trim();
      const rawRemote = String(query.remote ?? ctx.action?.params?.remote ?? '');

      const contentType = String(ctx.request.headers['content-type'] ?? '');
      if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
        ctx.throw(400, 'Expected multipart/form-data upload');
      }

      const maxBytes = getMaxUploadBytes();
      const formatMaxLabel = () =>
        maxBytes >= 1024 * 1024 ? `${Math.round((maxBytes / (1024 * 1024)) * 100) / 100} MB` : `${maxBytes} bytes`;
      const rawContentLength = ctx.request.headers['content-length'];
      const declaredLength = rawContentLength !== undefined ? Number(rawContentLength) : Number.NaN;
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        ctx.throw(413, `Upload exceeds maximum size of ${formatMaxLabel()}`);
      }

      const abortController = new AbortController();
      const onAborted = () => abortController.abort();
      ctx.req.once('aborted', onAborted);

      let bytesRead = 0;
      const limitedStream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytesRead += chunk.length;
          if (bytesRead > maxBytes) {
            const limitErr = new RcloneRcError(`Upload exceeds maximum size of ${formatMaxLabel()}`, 413);
            abortController.abort(limitErr);
            callback(limitErr);
            return;
          }
          callback(null, chunk);
        },
      });
      limitedStream.on('error', () => {});
      const onReqError = (err: Error) => {
        if (!limitedStream.destroyed) {
          limitedStream.destroy(err);
        }
      };
      ctx.req.once('error', onReqError);

      try {
        const remote = normalizeRemoteSubPath(rawRemote);
        const { client } = await connectionManager.getClient(connectionId);
        await assertFsTargetsPermitted(ctx, client, [fs]);
        if (!remote && (await client.isUnrootedBucketFs(fs))) {
          ctx.throw(
            400,
            `Cannot upload files directly to the root of bucket-based remote "${fs}". Open a bucket folder first (e.g. "${fs}my-bucket").`,
          );
        }

        ctx.req.pipe(limitedStream);
        await client.uploadMultipartStream(
          fs,
          remote,
          limitedStream,
          contentType,
          Number.isFinite(declaredLength) && declaredLength > 0 ? String(declaredLength) : undefined,
          abortController.signal,
        );
        ctx.body = { ok: true };
      } catch (error) {
        ctx.req.unpipe(limitedStream);
        if (abortController.signal.aborted && abortController.signal.reason instanceof RcloneRcError) {
          if (abortController.signal.reason.status === 413) {
            ctx.set?.('Connection', 'close');
          }
          rethrowRcError(ctx, abortController.signal.reason);
        }
        rethrowRcError(ctx, error);
      } finally {
        ctx.req.unpipe(limitedStream);
        ctx.req.off('aborted', onAborted);
        ctx.req.off('error', onReqError);
        if (!limitedStream.destroyed) {
          limitedStream.destroy();
        }
      }
      await next();
    },

    async signDownload(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const connectionId = Number(input.connectionId);
      const fs = String(input.fs ?? '').trim();
      const isDir = Boolean(input.isDir);
      const mode = input.mode === 'inline' ? 'inline' : 'attachment';

      try {
        const remote = normalizeRemoteSubPath(String(input.remote ?? ''));
        const { client } = await connectionManager.getClient(connectionId);
        await assertFsTargetsPermitted(ctx, client, [fs]);

        const signingOpts = {
          appSecret: (
            plugin.app as { authManager?: { jwt?: { getSecret?: () => string | Buffer } } }
          ).authManager?.jwt?.getSecret?.(),
          appName: plugin.app.name,
        };
        const signedQuery = createSignedDownloadQuery({
          connectionId,
          fs,
          remote,
          isDir,
          mode,
          ...signingOpts,
        });
        const apiPrefix = String(plugin.app.resourcer?.options?.prefix ?? '/api').replace(/\/+$/, '');
        ctx.body = {
          url: `${apiPrefix}/${RESOURCE_NAME}:downloadStream?${signedQuery}`,
        };
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async downloadStream(ctx: Context) {
      const q = ctx.request.query as Record<string, string | undefined>;
      const payload: RcloneSignedStreamPayload = {
        connectionId: Number(q.connectionId),
        fs: String(q.fs ?? ''),
        remote: String(q.remote ?? ''),
        isDir: q.isDir === '1',
        mode: q.mode === 'inline' ? 'inline' : 'attachment',
        expires: Number(q.expires),
      };
      const signature = String(q.sig ?? '');
      const signingOpts = {
        appSecret: (
          plugin.app as { authManager?: { jwt?: { getSecret?: () => string | Buffer } } }
        ).authManager?.jwt?.getSecret?.(),
        appName: plugin.app.name,
      };

      if (!verifyStreamSignature(payload, signature, signingOpts)) {
        ctx.throw(403, 'Invalid or expired download signature');
      }

      const abortController = new AbortController();
      const onReqAborted = () => abortController.abort();
      ctx.req.once('aborted', onReqAborted);

      try {
        const { client } = await connectionManager.getClient(payload.connectionId);
        const rangeHeader = typeof ctx.request.headers.range === 'string' ? ctx.request.headers.range : undefined;
        const handle = await client.openDownloadStream(
          payload.fs,
          payload.remote,
          payload.isDir,
          rangeHeader,
          abortController.signal,
        );

        const cleanupStream = () => {
          if (!ctx.res.writableEnded) {
            abortController.abort();
          }
          handle.cleanup().catch(() => {});
        };
        ctx.req.once('close', cleanupStream);
        ctx.res.once('close', cleanupStream);

        const effectiveMode: 'inline' | 'attachment' =
          payload.mode === 'inline' &&
          !ACTIVE_CONTENT_EXT_RE.test(handle.filename) &&
          !ACTIVE_CONTENT_MIME_RE.test(handle.contentType)
            ? 'inline'
            : 'attachment';

        ctx.status = handle.status;
        ctx.set('Content-Type', handle.contentType);
        ctx.set('Content-Security-Policy', 'sandbox');
        ctx.set('X-Content-Type-Options', 'nosniff');
        ctx.set('Cache-Control', 'private, no-store');
        ctx.set('Content-Disposition', buildContentDisposition(handle.filename, effectiveMode));
        if (handle.contentLength) ctx.set('Content-Length', handle.contentLength);
        if (handle.contentRange) ctx.set('Content-Range', handle.contentRange);
        if (handle.acceptRanges) ctx.set('Accept-Ranges', handle.acceptRanges);
        ctx.body = handle.stream;
      } catch (error) {
        rethrowRcError(ctx, error);
      } finally {
        ctx.req.off('aborted', onReqAborted);
      }
    },

    async triggerTransferWorkflow(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const connectionId = Number(input.connectionId);
      const operation = String(input.operation ?? 'sync/copy').trim();
      const srcFs = String(input.srcFs ?? '').trim();
      const dstFs = String(input.dstFs ?? '').trim();

      if (!isTransferOp(operation)) {
        ctx.throw(400, `Invalid transfer operation "${operation}"`);
      }
      if (!srcFs || !dstFs) {
        ctx.throw(400, 'Both srcFs and dstFs are required');
      }

      try {
        const srcRemote = normalizeRemoteSubPath(String(input.srcRemote ?? ''));
        const dstRemote = normalizeRemoteSubPath(String(input.dstRemote ?? ''));

        const { client } = await connectionManager.getClient(connectionId);
        await assertFsTargetsPermitted(ctx, client, [srcFs, dstFs]);

        if (operation === 'operations/copyfile' || operation === 'operations/movefile') {
          if (!srcRemote || !dstRemote) {
            ctx.throw(400, `${operation} requires both srcRemote and dstRemote file paths`);
          }
          if (!srcRemote.includes('/') && (await client.isUnrootedBucketFs(srcFs))) {
            ctx.throw(
              400,
              `Source "${srcFs}" is bucket-based storage (S3/MinIO/GCS); include a bucket name in Source Sub-path (e.g. "my-bucket/${srcRemote}").`,
            );
          }
          if (!dstRemote.includes('/') && (await client.isUnrootedBucketFs(dstFs))) {
            ctx.throw(
              400,
              `Destination "${dstFs}" is bucket-based storage (S3/MinIO/GCS) and cannot store files at root. Open a bucket first or include a bucket in Destination Sub-path (e.g. "my-bucket/${dstRemote}").`,
            );
          }
        }

        const perms = resolveContextPermissions(ctx as unknown as PermissionCheckContext);
        const defaultWf = await ensureDefaultExplorerWorkflow(plugin.app);
        if (!defaultWf) {
          ctx.throw(500, 'NocoBase Workflow plugin is not available to execute sync/copy transfers');
        }
        if (!defaultWf.enabled) {
          ctx.throw(400, `Transfer workflow "${defaultWf.title}" is currently disabled in Workflow Settings`);
        }

        const filterRules =
          input.filterRules && typeof input.filterRules === 'object' && !Array.isArray(input.filterRules)
            ? (input.filterRules as Record<string, unknown>)
            : null;

        const srcLabel = srcRemote ? `${srcFs.replace(/\/+$/, '')}/${srcRemote}` : srcFs;
        const dstLabel = dstRemote ? `${dstFs.replace(/\/+$/, '')}/${dstRemote}` : dstFs;

        const localAuthorized =
          perms.canLocalFs &&
          (isConnectionStringOverride(srcFs) ||
            isConnectionStringOverride(dstFs) ||
            (await client.isFsLocal(srcFs)) ||
            (await client.isFsLocal(dstFs)));

        const taskRepo = plugin.db.getRepository(COLLECTIONS.tasks);
        const createdTask = await taskRepo.create({
          values: {
            title: `${operation}: ${srcLabel} -> ${dstLabel}`,
            connectionId,
            operation,
            srcFs,
            srcRemote,
            dstFs,
            dstRemote,
            createEmptySrcDirs: Boolean(input.createEmptySrcDirs),
            deleteEmptySrcDirs: Boolean(input.deleteEmptySrcDirs),
            dryRun: Boolean(input.dryRun),
            filterRules,
            triggerSource: 'explorer',
            localAuthorized,
            status: 'queued',
            createdById: (ctx.state as { currentUser?: { id?: number } } | undefined)?.currentUser?.id ?? null,
          },
          context: ctx,
        });

        ctx.body = createdTask.toJSON();
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async listJobs(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const connectionId = Number(input.connectionId);
      const perms = resolveContextPermissions(ctx as unknown as PermissionCheckContext);
      try {
        // Trigger background reconciliation without blocking GET responses on slow/unreachable rclone daemons.
        plugin.reconciler.kick(0);
        const taskRepo = plugin.db.getRepository(COLLECTIONS.tasks);
        const filter: Record<string, unknown> = {};
        if (Number.isFinite(connectionId) && connectionId > 0) {
          filter.connectionId = connectionId;
        }
        if (!perms.canLocalFs) {
          filter.localAuthorized = { $isFalsy: true };
        }
        const tasks = (await taskRepo.find({
          filter,
          sort: ['-id'],
          limit: 100,
        })) as Model[];
        ctx.body = tasks.map((row) => row.toJSON());
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async stopJob(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const taskId = Number(input.taskId ?? input.id);
      if (!Number.isFinite(taskId) || taskId <= 0) {
        ctx.throw(400, 'Valid taskId is required');
      }
      const perms = resolveContextPermissions(ctx as unknown as PermissionCheckContext);
      try {
        const taskRepo = plugin.db.getRepository(COLLECTIONS.tasks);
        let task = await taskRepo.findOne({ filterByTk: taskId });
        if (!task) {
          ctx.throw(404, `Transfer task #${taskId} not found`);
        }
        if (Boolean(task.get('localAuthorized')) && !perms.canLocalFs) {
          ctx.throw(403, 'High-privilege permission "local-fs" is required to stop host local disk transfer jobs');
        }

        const currentStatus = String(task.get('status') ?? '');
        if (currentStatus === 'stopped') {
          ctx.body = { stopped: true, status: 'stopped', taskId };
          await next();
          return;
        }
        if (currentStatus === 'completed' || currentStatus === 'failed') {
          ctx.throw(409, `Transfer task #${taskId} is already ${currentStatus}`);
        }
        if (currentStatus === 'unverified') {
          ctx.throw(409, `Transfer task #${taskId} has unverified job identity and cannot be stopped safely`);
        }
        if (currentStatus === 'starting') {
          ctx.throw(409, `Transfer task #${taskId} is currently starting on daemon; retry stopping in a moment`);
        }

        const connectionId = Number(task.get('connectionId'));
        let rcloneJobId = Number(task.get('rcloneJobId'));
        let rcloneExecuteId = String(task.get('rcloneExecuteId') ?? '').trim() || undefined;
        let rcloneGroup = String(task.get('rcloneGroup') ?? '').trim() || undefined;

        const taskCollection = plugin.db?.getCollection?.(COLLECTIONS.tasks);
        const taskModelUpdate = (taskCollection?.model as { update?: typeof Model.update } | undefined)?.update;
        if (!(Number.isFinite(rcloneJobId) && rcloneJobId > 0)) {
          if (currentStatus !== 'queued') {
            plugin.reconciler.kick(0);
            ctx.throw(409, `Transfer task #${taskId} has no verified daemon job ID yet; cannot confirm stop`);
          }
          if (typeof taskModelUpdate === 'function') {
            const [stoppedQueued] = await taskModelUpdate.call(
              taskCollection.model,
              {
                status: 'stopped',
                eta: null,
                errorText: 'Stopped by user',
                completedAt: new Date(),
              },
              { where: { id: taskId, status: 'queued' } },
            );
            if (stoppedQueued > 0) {
              ctx.body = { stopped: true, status: 'stopped', taskId };
              await next();
              return;
            }
            task = await taskRepo.findOne({ filterByTk: taskId });
            if (!task) {
              ctx.throw(404, `Transfer task #${taskId} not found`);
            }
            const racedStatus = String(task.get('status') ?? '');
            if (racedStatus === 'stopped') {
              ctx.body = { stopped: true, status: 'stopped', taskId };
              await next();
              return;
            }
            if (racedStatus === 'completed' || racedStatus === 'failed') {
              ctx.throw(409, `Transfer task #${taskId} is already ${racedStatus}`);
            }
            if (racedStatus === 'unverified') {
              ctx.throw(409, `Transfer task #${taskId} has unverified job identity and cannot be stopped safely`);
            }
            rcloneJobId = Number(task.get('rcloneJobId'));
            rcloneExecuteId = String(task.get('rcloneExecuteId') ?? '').trim() || undefined;
            rcloneGroup = String(task.get('rcloneGroup') ?? '').trim() || undefined;
            if (!(Number.isFinite(rcloneJobId) && rcloneJobId > 0)) {
              ctx.throw(409, `Transfer task #${taskId} is currently starting on daemon; retry stopping in a moment`);
            }
          }
        }

        const workflowPlugin = plugin.app.pm.get('workflow') as WorkflowPlugin | undefined;

        if (Number.isFinite(rcloneJobId) && rcloneJobId > 0) {
          if (!rcloneGroup && !rcloneExecuteId) {
            ctx.throw(
              409,
              `Transfer task #${taskId} has unverified job identity (missing executeId and group) and cannot be stopped safely`,
            );
          }

          const { client } = await connectionManager.getClient(connectionId, false);
          const hasGetJobStatus = typeof (client as { getJobStatus?: unknown }).getJobStatus === 'function';

          let finalJobStatus: Awaited<ReturnType<typeof client.getJobStatus>> | undefined;
          let alreadyFinishedBeforeStop = false;

          if (hasGetJobStatus) {
            const preStopStatus = await client.getJobStatus(rcloneJobId, {
              executeId: rcloneExecuteId,
              group: rcloneGroup,
            });
            if (!preStopStatus || preStopStatus.finished) {
              finalJobStatus = preStopStatus;
              alreadyFinishedBeforeStop = true;
            }
          }

          if (!alreadyFinishedBeforeStop) {
            try {
              await client.stopJob(rcloneJobId, { executeId: rcloneExecuteId, group: rcloneGroup });
            } catch (stopError) {
              if (stopError instanceof RcloneRcError && stopError.status === 409) {
                plugin.reconciler.kick(0);
              }
              throw stopError;
            }

            try {
              finalJobStatus = await client.getJobStatus(rcloneJobId, {
                executeId: rcloneExecuteId,
                group: rcloneGroup,
              });
              for (let attempt = 0; attempt < 5 && finalJobStatus && !finalJobStatus.finished; attempt++) {
                await new Promise<void>((resolve) => setTimeout(resolve, 50));
                finalJobStatus = await client.getJobStatus(rcloneJobId, {
                  executeId: rcloneExecuteId,
                  group: rcloneGroup,
                });
              }
            } catch (verifyError) {
              plugin.reconciler.kick(250);
              throw verifyError;
            }
          }

          if (!finalJobStatus) {
            const resumed = await plugin.reconciler.finalizeTaskAndWorkflowJob(task, new Map(), workflowPlugin, {
              status: 'unverified',
              success: false,
              errorText: 'Rclone job outcome could not be verified (job history expired on daemon or daemon restarted)',
            });
            if (!resumed) {
              plugin.reconciler.kick(400);
            }
            ctx.body = { stopped: false, status: 'unverified', taskId };
            await next();
            return;
          }

          if (!finalJobStatus.finished) {
            plugin.reconciler.kick(250);
            ctx.throw(
              409,
              `Stop signal sent for transfer task #${taskId}, but daemon has not confirmed termination yet`,
            );
          }

          const groupName = rcloneGroup || finalJobStatus.group || `job/${rcloneJobId}`;
          const groupStats =
            typeof (client as { getStats?: unknown }).getStats === 'function'
              ? await client.getStats(groupName).catch(() => null)
              : null;
          let finalBytes = Number(groupStats?.bytes ?? task.get('bytes') ?? 0);
          let finalTotalBytes = Number(groupStats?.totalBytes ?? task.get('totalBytes') ?? 0);

          if (finalJobStatus.success) {
            if (
              finalBytes === 0 &&
              finalTotalBytes === 0 &&
              typeof (client as { getTransferred?: unknown }).getTransferred === 'function'
            ) {
              const transferredRes = await client.getTransferred(groupName).catch(() => null);
              const items = transferredRes?.transferred ?? [];
              if (items.length > 0) {
                const summed = items.reduce((acc, item) => acc + Number(item.bytes ?? item.size ?? 0), 0);
                finalBytes = summed;
                finalTotalBytes = summed;
              }
            }
            const resumed = await plugin.reconciler.finalizeTaskAndWorkflowJob(task, new Map(), workflowPlugin, {
              status: 'completed',
              success: true,
              bytes: finalBytes,
              totalBytes: finalTotalBytes,
              duration: finalJobStatus.duration ?? 0,
              errorText: '',
            });
            if (!resumed) {
              plugin.reconciler.kick(400);
            }
            ctx.body = { stopped: false, status: 'completed', taskId };
            await next();
            return;
          }

          const daemonError = extractDaemonJobError(finalJobStatus.output, finalJobStatus.error);
          if (alreadyFinishedBeforeStop || !isCancellationJobError(daemonError)) {
            const preservedError = daemonError || 'Rclone transfer job failed';
            const resumed = await plugin.reconciler.finalizeTaskAndWorkflowJob(task, new Map(), workflowPlugin, {
              status: 'failed',
              success: false,
              bytes: finalBytes,
              totalBytes: finalTotalBytes,
              duration: finalJobStatus.duration ?? 0,
              errorText: preservedError,
            });
            if (!resumed) {
              plugin.reconciler.kick(400);
            }
            ctx.body = { stopped: false, status: 'failed', taskId };
            await next();
            return;
          }

          const resumed = await plugin.reconciler.finalizeTaskAndWorkflowJob(task, new Map(), workflowPlugin, {
            status: 'stopped',
            success: false,
            bytes: finalBytes,
            totalBytes: finalTotalBytes,
            duration: finalJobStatus.duration ?? 0,
            errorText: 'Stopped by user',
          });
          if (!resumed) {
            plugin.reconciler.kick(400);
          }
          ctx.body = { stopped: true, status: 'stopped', taskId };
          await next();
          return;
        }

        const resumed = await plugin.reconciler.finalizeTaskAndWorkflowJob(task, new Map(), workflowPlugin, {
          status: 'stopped',
          success: false,
          errorText: 'Stopped by user',
        });
        if (!resumed) {
          plugin.reconciler.kick(400);
        }
        ctx.body = { stopped: true, status: 'stopped', taskId };
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async listMountTypes(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        ctx.body = await client.listMountTypes();
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async listMounts(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        ctx.body = await client.listMounts();
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async createMount(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const fs = String(input.fs ?? '').trim();
      const mountPoint = String(input.mountPoint ?? '').trim();
      if (!fs || !mountPoint) {
        ctx.throw(400, 'Both fs and mountPoint are required');
      }
      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        await assertFsTargetsPermitted(ctx, client, [fs]);
        const body: Record<string, unknown> = { fs, mountPoint };
        if (input.mountType) body.mountType = String(input.mountType);
        if (input.vfsOpt && typeof input.vfsOpt === 'object') body.vfsOpt = input.vfsOpt;
        if (input.mountOpt && typeof input.mountOpt === 'object') body.mountOpt = input.mountOpt;
        await client.createMount(body);
        ctx.body = { ok: true };
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async unmount(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const mountPoint = String(input.mountPoint ?? '').trim();
      if (!mountPoint) ctx.throw(400, 'mountPoint is required');
      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        await client.unmount(mountPoint);
        ctx.body = { ok: true };
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async unmountAll(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        await client.unmountAll();
        ctx.body = { ok: true };
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async listServeTypes(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        ctx.body = await client.listServeTypes();
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async listServes(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        ctx.body = await client.listServes();
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async startServe(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const type = String(input.type ?? '').trim();
      const fs = String(input.fs ?? '').trim();
      if (!type || !fs) {
        ctx.throw(400, 'Both serve protocol type and fs are required');
      }
      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        await assertFsTargetsPermitted(ctx, client, [fs]);

        const body: Record<string, unknown> = { type, fs };
        if (input.addr) body.addr = String(input.addr).trim();
        if (input.user) body.user = String(input.user).trim();
        if (input.pass) body.pass = String(input.pass);
        const vfsOpt: Record<string, unknown> =
          input.vfsOpt && typeof input.vfsOpt === 'object' && !Array.isArray(input.vfsOpt)
            ? { ...(input.vfsOpt as Record<string, unknown>) }
            : {};
        if (input.readOnly !== undefined) {
          vfsOpt.ReadOnly = Boolean(input.readOnly);
        }
        if (Object.keys(vfsOpt).length > 0) {
          body.vfsOpt = vfsOpt;
        }

        ctx.body = await client.startServe(body);
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async stopServe(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const id = String(input.id ?? '').trim();
      if (!id) ctx.throw(400, 'Serve id is required');
      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        await client.stopServe(id);
        ctx.body = { ok: true };
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async stopAllServes(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        await client.stopAllServes();
        ctx.body = { ok: true };
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async getRuntimeOptions(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        const [options, paths] = await Promise.all([client.getOptions(), client.getConfigPaths()]);
        const main = options.main ?? {};
        const log = options.log ?? {};
        const summary: RcloneRuntimeOptionsSummary = {
          transfers: Number(main.Transfers ?? 4),
          checkers: Number(main.Checkers ?? 8),
          bwLimit: String(main.BwLimit ?? ''),
          tpsLimit: Number(main.TPSLimit ?? 0),
          logLevel: String(main.LogLevel ?? 'NOTICE'),
          logFile: String(log.File ?? ''),
        };
        ctx.body = { options: summary, paths };
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async setRuntimeOptions(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        const mainPatch: Record<string, unknown> = {};
        const logPatch: Record<string, unknown> = {};

        if (input.transfers !== undefined) mainPatch.Transfers = Math.max(1, Number(input.transfers) || 4);
        if (input.checkers !== undefined) mainPatch.Checkers = Math.max(1, Number(input.checkers) || 8);
        if (input.bwLimit !== undefined) mainPatch.BwLimit = String(input.bwLimit).trim() || 'off';
        if (input.tpsLimit !== undefined) mainPatch.TPSLimit = Math.max(0, Number(input.tpsLimit) || 0);
        if (input.logLevel !== undefined) mainPatch.LogLevel = String(input.logLevel);
        if (input.logFile !== undefined) {
          const nextLogFile = String(input.logFile).trim();
          const currentOpts = await client.getOptions().catch(() => ({}));
          const currentLogFile = String((currentOpts.log as Record<string, unknown> | undefined)?.File ?? '').trim();
          if (nextLogFile && nextLogFile !== currentLogFile) {
            assertLocalFsPermitted(ctx, [':local:']);
          }
          if (nextLogFile !== currentLogFile) {
            logPatch.File = nextLogFile;
          }
        }

        const body: Record<string, unknown> = {};
        if (Object.keys(mainPatch).length > 0) body.main = mainPatch;
        if (Object.keys(logPatch).length > 0) body.log = logPatch;

        if (Object.keys(body).length > 0) {
          await client.setOptions(body);
        }
        ctx.body = { ok: true };
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async getRawConfig(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        ctx.body = await client.readRawConfigFile();
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },

    async saveRawConfig(ctx: Context, next: Next) {
      const input = getParamRecord(ctx);
      const content = String(input.content ?? '');
      try {
        const { client } = await connectionManager.getClient(String(input.connectionId ?? ''));
        ctx.body = await client.writeRawConfigFile(content);
      } catch (error) {
        rethrowRcError(ctx, error);
      }
      await next();
    },
  };
}
