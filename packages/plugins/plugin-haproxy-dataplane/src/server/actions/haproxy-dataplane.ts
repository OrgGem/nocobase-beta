// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from '@nocobase/actions';
import { COLLECTIONS, SECRET_MASK } from '../../shared/constants';
import type {
  BatchSyncItemResult,
  DeleteReverseProxyInput,
  HaproxyAclConfig,
  HaproxyAdminState,
  HaproxyAuthType,
  HaproxyBackendConfig,
  HaproxyBackendSwitchingRule,
  HaproxyBindConfig,
  HaproxyFleetNodeStatus,
  HaproxyFrontendConfig,
  HaproxyHttpRequestRule,
  HaproxyServerConfig,
  ToggleReverseProxyInput,
  UpsertReverseProxyInput,
} from '../../shared/types';
import { resolveContextPermissions, type PermissionCheckContext } from '../permissions';
import type { PluginHaproxyDataplaneServer } from '../plugin';
import {
  clampTimeoutMs,
  DataplaneApiError,
  DataplaneV3Client,
  mapWithConcurrency,
  normalizeDataplaneV3BaseUrl,
  type ConfigWriteOptions,
  type StorageWriteOptions,
} from '../services/dataplane-v3-client';

const CONNECTION_SLUG_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function extractValues(ctx: Context): Record<string, unknown> {
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

function handleActionError(ctx: Context, error: unknown): never {
  if (error instanceof DataplaneApiError) {
    ctx.throw(error.status, error.message);
  }
  const status =
    error &&
    typeof error === 'object' &&
    'status' in error &&
    typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : 500;
  const msg = error instanceof Error ? error.message : String(error);
  ctx.throw(status, msg);
}

function sameOrigin(urlA: string, urlB: string): boolean {
  try {
    return new URL(urlA).origin === new URL(urlB).origin;
  } catch {
    return false;
  }
}

function assertValidConnectionName(rawName: unknown): string {
  const name = String(rawName ?? '').trim();
  if (!CONNECTION_SLUG_REGEX.test(name)) {
    throw new DataplaneApiError(
      'Connection name must start with an alphanumeric character and contain only letters, digits, dots, hyphens, or underscores',
      400,
    );
  }
  return name;
}

function parseWriteOptions(values: Record<string, unknown>): ConfigWriteOptions {
  return {
    transactionId: values.transactionId ? String(values.transactionId) : undefined,
    version: values.version !== undefined && values.version !== null ? Number(values.version) : undefined,
    forceReload: Boolean(values.forceReload),
  };
}

function parseStorageOptions(values: Record<string, unknown>): StorageWriteOptions {
  return {
    forceReload: Boolean(values.forceReload),
    skipReload: Boolean(values.skipReload),
  };
}

function parseTargetIds(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new DataplaneApiError('At least one target connectionId is required', 400);
  }
  const unique = Array.from(new Set(raw.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  if (unique.length === 0 || unique.length > 50) {
    throw new DataplaneApiError('Target connectionIds must contain between 1 and 50 valid IDs', 400);
  }
  return unique;
}

export function createHaproxyDataplaneActions(plugin: PluginHaproxyDataplaneServer) {
  const { connectionManager, revisionAudit, reverseProxy } = plugin;

  const afterStructuredWrite = async (
    ctx: Context,
    model: { get: (k: string) => unknown },
    client: DataplaneV3Client,
    opts: ConfigWriteOptions,
    action: string,
    target: string,
  ) => {
    const connectionId = Number(model.get('id'));
    const connectionName = String(model.get('name'));
    await revisionAudit.recordAudit(ctx, {
      connectionId,
      connectionName,
      category: 'config',
      action,
      target,
      detail: opts.transactionId ? `staged in tx ${opts.transactionId}` : 'applied directly',
    });
    if (!opts.transactionId) {
      await revisionAudit.captureRevisionBestEffort({
        connectionId,
        connectionName,
        client,
        source: 'structured',
        summary: `${action} (${target})`,
        ctx,
      });
    }
  };

  return {
    async myPermissions(ctx: Context, next: Next) {
      ctx.body = resolveContextPermissions(ctx as unknown as PermissionCheckContext);
      await next();
    },

    async listConnections(ctx: Context, next: Next) {
      const perms = resolveContextPermissions(ctx as unknown as PermissionCheckContext);
      const repo = plugin.app.db.getRepository(COLLECTIONS.connections);
      const rows = await repo.find({
        filter: perms.canManageConnections ? {} : { enabled: true },
        sort: ['id'],
      });
      ctx.body = rows.map((row) => connectionManager.toPublicConnection(row, perms.canManageConnections));
      await next();
    },

    async fleetOverview(ctx: Context, next: Next) {
      try {
        const repo = plugin.app.db.getRepository(COLLECTIONS.connections);
        const rows = await repo.find({ filter: { enabled: true }, sort: ['id'] });
        const statuses = await mapWithConcurrency(rows, 6, async (row): Promise<HaproxyFleetNodeStatus> => {
          const connectionId = Number(row.get('id'));
          const name = String(row.get('name') ?? '');
          const title = (row.get('title') as string | null) ?? null;
          try {
            const client = await connectionManager.getClientByModel(row);
            const [apiInfo, processInfo, stats, configVersion, openTxs, reloads] = await Promise.all([
              client.getInfo(),
              client.getProcessInfo(),
              client.getNativeStats(),
              client.getConfigVersion().catch(() => null),
              client.listTransactions('in_progress').catch(() => []),
              client.listReloads().catch(() => []),
            ]);
            const servers = stats.rows.filter((r) => r.type === 'server');
            const upServers = servers.filter((s) => s.status.toUpperCase().startsWith('UP')).length;
            const latestReload = reloads[reloads.length - 1] ?? null;

            return {
              connectionId,
              name,
              title,
              reachable: true,
              error: processInfo.error ?? stats.statsError ?? null,
              hostname: apiInfo.hostname,
              apiVersion: apiInfo.apiVersion,
              haproxyVersion: processInfo.version,
              uptime: processInfo.uptime,
              configVersion,
              currConns: processInfo.currConns,
              maxConn: processInfo.maxConn,
              upServers,
              totalServers: servers.length,
              frontendsCount: stats.rows.filter((r) => r.type === 'frontend').length,
              backendsCount: stats.rows.filter((r) => r.type === 'backend').length,
              openTransactions: openTxs.length,
              lastReloadStatus: latestReload?.status ?? null,
              lastReloadId: latestReload?.id ?? null,
            };
          } catch (err) {
            return {
              connectionId,
              name,
              title,
              reachable: false,
              error: err instanceof Error ? err.message : String(err),
              hostname: null,
              apiVersion: (row.get('lastApiVersion') as string | null) ?? null,
              haproxyVersion: (row.get('lastHaproxyVersion') as string | null) ?? null,
              uptime: null,
              configVersion: null,
              currConns: null,
              maxConn: null,
              upServers: 0,
              totalServers: 0,
              frontendsCount: 0,
              backendsCount: 0,
              openTransactions: 0,
              lastReloadStatus: null,
              lastReloadId: null,
            };
          }
        });
        ctx.body = statuses;
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    // --- Unified Reverse Proxy (In -> Out) ---

    async listReverseProxies(ctx: Context, next: Next) {
      try {
        const rawConnId = ctx.action?.params?.connectionId;
        const filterConnId =
          rawConnId != null && Number.isFinite(Number(rawConnId)) && Number(rawConnId) > 0
            ? Number(rawConnId)
            : undefined;
        const repo = plugin.app.db.getRepository(COLLECTIONS.connections);
        const rows = await repo.find({ filter: { enabled: true }, sort: ['id'] });
        ctx.body = await reverseProxy.listReverseProxies(rows, filterConnId);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async upsertReverseProxy(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx) as unknown as UpsertReverseProxyInput;
        const { model, client } = await connectionManager.getClient(values.connectionId, true);
        const connectionId = Number(model.get('id'));
        const connectionName = String(model.get('name'));
        const result = await reverseProxy.upsertReverseProxy(client, values);
        const actionLabel = values.isEdit ? 'editReverseProxy' : 'createReverseProxy';
        await revisionAudit.recordAudit(ctx, {
          connectionId,
          connectionName,
          category: 'config',
          action: actionLabel,
          target: `${result.frontendName} -> ${result.backendName}`,
        });
        await revisionAudit.captureRevisionBestEffort({
          connectionId,
          connectionName,
          client,
          source: 'structured',
          summary: `${actionLabel} (${result.frontendName} -> ${result.backendName})`,
          ctx,
        });
        ctx.body = result;
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async toggleReverseProxy(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx) as unknown as ToggleReverseProxyInput;
        const { model, client } = await connectionManager.getClient(values.connectionId, true);
        const connectionId = Number(model.get('id'));
        const connectionName = String(model.get('name'));
        const meta = await reverseProxy.toggleReverseProxy(client, {
          connectionId,
          kind: values.kind === 'routing_rule' ? 'routing_rule' : 'dedicated_port',
          frontendName: String(values.frontendName ?? ''),
          backendName: String(values.backendName ?? ''),
          enabled: Boolean(values.enabled),
        });
        const stateStr = values.enabled ? 'enabled' : 'disabled';
        await revisionAudit.recordAudit(ctx, {
          connectionId,
          connectionName,
          category: 'config',
          action: 'toggleReverseProxy',
          target: `${values.frontendName} -> ${values.backendName}`,
          detail: stateStr,
        });
        await revisionAudit.captureRevisionBestEffort({
          connectionId,
          connectionName,
          client,
          source: 'structured',
          summary: `${stateStr} reverse proxy ${values.frontendName} -> ${values.backendName}`,
          ctx,
        });
        ctx.body = meta;
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async deleteReverseProxy(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx) as unknown as DeleteReverseProxyInput;
        const { model, client } = await connectionManager.getClient(values.connectionId, true);
        const connectionId = Number(model.get('id'));
        const connectionName = String(model.get('name'));
        const meta = await reverseProxy.deleteReverseProxy(client, {
          connectionId,
          kind: values.kind === 'routing_rule' ? 'routing_rule' : 'dedicated_port',
          frontendName: String(values.frontendName ?? ''),
          backendName: String(values.backendName ?? ''),
          ruleIndex: values.ruleIndex != null ? Number(values.ruleIndex) : null,
        });
        await revisionAudit.recordAudit(ctx, {
          connectionId,
          connectionName,
          category: 'config',
          action: 'deleteReverseProxy',
          target: `${values.frontendName} -> ${values.backendName}`,
        });
        await revisionAudit.captureRevisionBestEffort({
          connectionId,
          connectionName,
          client,
          source: 'structured',
          summary: `deleteReverseProxy (${values.frontendName} -> ${values.backendName})`,
          ctx,
        });
        ctx.body = meta;
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    // --- Connections CRUD ---

    async createConnection(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const name = assertValidConnectionName(values.name);
        const rawUrl = String(values.baseUrl ?? '').trim();
        const rawUsername = values.username != null ? String(values.username).trim() : '';
        const rawPassword = values.password != null ? String(values.password) : '';

        connectionManager.assertEnvReferencesPermitted(
          [rawUrl, rawUsername, rawPassword],
          ctx as unknown as PermissionCheckContext,
        );
        connectionManager.resolveNormalizedUrl(rawUrl);

        const authType: HaproxyAuthType = values.authType === 'none' ? 'none' : 'basic';
        const encryptedPassword =
          rawPassword && rawPassword !== SECRET_MASK ? await connectionManager.encryptPassword(rawPassword) : null;

        const repo = plugin.app.db.getRepository(COLLECTIONS.connections);
        const existing = await repo.findOne({ filter: { name } });
        if (existing) {
          throw new DataplaneApiError(`Connection "${name}" already exists`, 409);
        }

        const created = await repo.create({
          values: {
            name,
            title: values.title ? String(values.title).trim() : null,
            baseUrl: rawUrl,
            authType,
            username: authType === 'basic' ? rawUsername : null,
            password: authType === 'basic' ? encryptedPassword : null,
            tlsSkipVerify: Boolean(values.tlsSkipVerify),
            timeoutMs: clampTimeoutMs(values.timeoutMs),
            enabled: values.enabled !== false,
            notes: values.notes ? String(values.notes) : null,
          },
        });

        await revisionAudit.recordAudit(ctx, {
          connectionId: Number(created.get('id')),
          connectionName: name,
          category: 'connection',
          action: 'createConnection',
          target: name,
        });

        ctx.body = connectionManager.toPublicConnection(created, true);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async updateConnection(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const existing = await connectionManager.getConnectionModel(values.id as number, false);
        const id = Number(existing.get('id'));

        const nextName =
          values.name !== undefined ? assertValidConnectionName(values.name) : String(existing.get('name'));
        if (nextName !== String(existing.get('name'))) {
          const dup = await plugin.app.db
            .getRepository(COLLECTIONS.connections)
            .findOne({ filter: { name: nextName } });
          if (dup && Number(dup.get('id')) !== id) {
            throw new DataplaneApiError(`Connection "${nextName}" already exists`, 409);
          }
        }

        const nextUrl = values.baseUrl !== undefined ? String(values.baseUrl).trim() : String(existing.get('baseUrl'));
        const nextAuthType: HaproxyAuthType =
          values.authType !== undefined
            ? values.authType === 'none'
              ? 'none'
              : 'basic'
            : existing.get('authType') === 'none'
              ? 'none'
              : 'basic';
        const nextUsername =
          values.username !== undefined ? String(values.username).trim() : String(existing.get('username') ?? '');
        const rawPassword = values.password !== undefined ? String(values.password) : undefined;
        const isNewPassword = rawPassword !== undefined && rawPassword !== '' && rawPassword !== SECRET_MASK;

        const changedEnvFields: Array<string | undefined> = [];
        if (nextUrl !== String(existing.get('baseUrl'))) changedEnvFields.push(nextUrl);
        if (nextUsername !== String(existing.get('username') ?? '')) changedEnvFields.push(nextUsername);
        if (isNewPassword) changedEnvFields.push(rawPassword);
        connectionManager.assertEnvReferencesPermitted(changedEnvFields, ctx as unknown as PermissionCheckContext);

        const prevNormalizedUrl = connectionManager.resolveNormalizedUrl(String(existing.get('baseUrl')));
        const nextNormalizedUrl = connectionManager.resolveNormalizedUrl(nextUrl);

        let nextEncryptedPassword = existing.get('password') as string | null;
        if (nextAuthType === 'none') {
          nextEncryptedPassword = null;
        } else if (isNewPassword) {
          nextEncryptedPassword = await connectionManager.encryptPassword(rawPassword);
        } else if (!sameOrigin(prevNormalizedUrl, nextNormalizedUrl) && nextEncryptedPassword) {
          throw new DataplaneApiError('Re-enter the password when changing the Data Plane API host/origin', 400);
        }

        const repo = plugin.app.db.getRepository(COLLECTIONS.connections);
        await repo.update({
          filterByTk: id,
          values: {
            name: nextName,
            title:
              values.title !== undefined ? (values.title ? String(values.title).trim() : null) : existing.get('title'),
            baseUrl: nextUrl,
            authType: nextAuthType,
            username: nextAuthType === 'basic' ? nextUsername : null,
            password: nextEncryptedPassword,
            tlsSkipVerify:
              values.tlsSkipVerify !== undefined
                ? Boolean(values.tlsSkipVerify)
                : Boolean(existing.get('tlsSkipVerify')),
            timeoutMs:
              values.timeoutMs !== undefined
                ? clampTimeoutMs(values.timeoutMs)
                : clampTimeoutMs(existing.get('timeoutMs')),
            enabled: values.enabled !== undefined ? Boolean(values.enabled) : existing.get('enabled') !== false,
            notes: values.notes !== undefined ? (values.notes ? String(values.notes) : null) : existing.get('notes'),
          },
        });
        connectionManager.invalidate(id);

        await revisionAudit.recordAudit(ctx, {
          connectionId: id,
          connectionName: nextName,
          category: 'connection',
          action: 'updateConnection',
          target: nextName,
        });

        const refreshed = await connectionManager.getConnectionModel(id, false);
        ctx.body = connectionManager.toPublicConnection(refreshed, true);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async deleteConnection(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const existing = await connectionManager.getConnectionModel(values.id as number, false);
        const id = Number(existing.get('id'));
        const name = String(existing.get('name'));
        await plugin.app.db.getRepository(COLLECTIONS.connections).destroy({ filterByTk: id });
        connectionManager.invalidate(id);
        await revisionAudit.recordAudit(ctx, {
          connectionId: id,
          connectionName: name,
          category: 'connection',
          action: 'deleteConnection',
          target: name,
        });
        ctx.body = { deleted: true, id };
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async testConnection(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.id as number, false);
        const id = Number(model.get('id'));
        const repo = plugin.app.db.getRepository(COLLECTIONS.connections);
        const now = new Date();
        try {
          const result = await client.testConnection();
          await repo.update({
            filterByTk: id,
            values: {
              lastCheckAt: now,
              lastApiVersion: result.apiInfo.apiVersion,
              lastHaproxyVersion: result.processInfo.version,
              lastError: result.processInfo.error ?? null,
            },
          });
          ctx.body = {
            ok: true,
            apiInfo: result.apiInfo,
            processInfo: result.processInfo,
          };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await repo.update({
            filterByTk: id,
            values: {
              lastCheckAt: now,
              lastError: errMsg,
            },
          });
          throw err;
        }
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async testConnectionDraft(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const rawUrl = String(values.baseUrl ?? '').trim();
        const authType: HaproxyAuthType = values.authType === 'none' ? 'none' : 'basic';
        const rawUsername = String(values.username ?? '').trim();
        const rawPassword = String(values.password ?? '');

        connectionManager.assertEnvReferencesPermitted(
          [rawUrl, rawUsername, rawPassword !== SECRET_MASK ? rawPassword : ''],
          ctx as unknown as PermissionCheckContext,
        );

        const resolvedUrl = normalizeDataplaneV3BaseUrl(connectionManager.resolveEnv(rawUrl, false));
        let effectivePassword = '';
        if (authType === 'basic') {
          if (rawPassword && rawPassword !== SECRET_MASK) {
            effectivePassword = connectionManager.resolveEnv(rawPassword, true);
          } else if (values.id) {
            const existing = await connectionManager.getConnectionModel(values.id as number, false);
            const savedUrl = connectionManager.resolveNormalizedUrl(String(existing.get('baseUrl')));
            if (!sameOrigin(savedUrl, resolvedUrl)) {
              throw new DataplaneApiError('Re-enter the password when testing a different Data Plane API origin', 400);
            }
            const decrypted = await connectionManager.decryptPassword(existing.get('password') as string | null);
            effectivePassword = connectionManager.resolveEnv(decrypted, true);
          }
        }

        const client = new DataplaneV3Client({
          baseUrl: resolvedUrl,
          authType,
          username: connectionManager.resolveEnv(rawUsername, true),
          password: effectivePassword,
          tlsSkipVerify: Boolean(values.tlsSkipVerify),
          timeoutMs: clampTimeoutMs(values.timeoutMs),
        });

        const result = await client.testConnection();
        ctx.body = {
          ok: true,
          apiInfo: result.apiInfo,
          processInfo: result.processInfo,
        };
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    // --- Live Snapshot, Runtime Servers, Runtime Maps & Stick Tables ---

    async getSnapshot(ctx: Context, next: Next) {
      try {
        const connectionId = ctx.action?.params?.connectionId;
        const { model, client } = await connectionManager.getClient(connectionId, true);
        ctx.body = await client.getSnapshot(Number(model.get('id')), String(model.get('name')));
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async updateRuntimeServer(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const backend = String(values.backend ?? '');
        const server = String(values.server ?? '');
        const patch = {
          adminState: values.adminState !== undefined ? (String(values.adminState) as HaproxyAdminState) : undefined,
          weight: values.weight !== undefined ? Number(values.weight) : undefined,
          address: values.address !== undefined ? String(values.address) : undefined,
          port: values.port !== undefined ? Number(values.port) : undefined,
        };
        const updated = await client.updateRuntimeServer(backend, server, patch);
        const detailParts: string[] = [];
        if (patch.adminState) detailParts.push(`admin_state=${patch.adminState}`);
        if (patch.weight !== undefined) detailParts.push(`weight=${patch.weight}`);
        await revisionAudit.recordAudit(ctx, {
          connectionId: Number(model.get('id')),
          connectionName: String(model.get('name')),
          category: 'runtime',
          action: 'updateRuntimeServer',
          target: `${backend}/${server}`,
          detail: detailParts.join(', '),
        });
        ctx.body = updated;
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async addRuntimeServer(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const backend = String(values.backend ?? '');
        const srvName = String(values.name ?? '');
        ctx.body = await client.addRuntimeServer(backend, {
          name: srvName,
          address: String(values.address ?? ''),
          port: values.port != null ? Number(values.port) : undefined,
          weight: values.weight != null ? Number(values.weight) : undefined,
          check: values.check === 'disabled' ? 'disabled' : values.check === 'enabled' ? 'enabled' : undefined,
          maintenance:
            values.maintenance === 'enabled' ? 'enabled' : values.maintenance === 'disabled' ? 'disabled' : undefined,
        });
        await revisionAudit.recordAudit(ctx, {
          connectionId: Number(model.get('id')),
          connectionName: String(model.get('name')),
          category: 'runtime',
          action: 'addRuntimeServer',
          target: `${backend}/${srvName}`,
        });
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async deleteRuntimeServer(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const backend = String(values.backend ?? '');
        const server = String(values.server ?? '');
        ctx.body = await client.deleteRuntimeServer(backend, server);
        await revisionAudit.recordAudit(ctx, {
          connectionId: Number(model.get('id')),
          connectionName: String(model.get('name')),
          category: 'runtime',
          action: 'deleteRuntimeServer',
          target: `${backend}/${server}`,
        });
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async listRuntimeMaps(ctx: Context, next: Next) {
      try {
        const { client } = await connectionManager.getClient(ctx.action?.params?.connectionId, true);
        ctx.body = await client.listRuntimeMaps();
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async getRuntimeMapEntries(ctx: Context, next: Next) {
      try {
        const { client } = await connectionManager.getClient(ctx.action?.params?.connectionId, true);
        ctx.body = await client.getRuntimeMapEntries(String(ctx.action?.params?.map ?? ''));
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async addRuntimeMapEntry(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const mapName = String(values.map ?? '');
        const key = String(values.key ?? '');
        ctx.body = await client.addRuntimeMapEntry(
          mapName,
          key,
          String(values.value ?? ''),
          values.forceSync !== false,
        );
        await revisionAudit.recordAudit(ctx, {
          connectionId: Number(model.get('id')),
          connectionName: String(model.get('name')),
          category: 'runtime',
          action: 'addRuntimeMapEntry',
          target: `${mapName}:${key}`,
        });
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async updateRuntimeMapEntry(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const mapName = String(values.map ?? '');
        const entryId = String(values.id ?? '');
        ctx.body = await client.updateRuntimeMapEntry(
          mapName,
          entryId,
          String(values.value ?? ''),
          values.forceSync !== false,
        );
        await revisionAudit.recordAudit(ctx, {
          connectionId: Number(model.get('id')),
          connectionName: String(model.get('name')),
          category: 'runtime',
          action: 'updateRuntimeMapEntry',
          target: `${mapName}:${entryId}`,
        });
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async deleteRuntimeMapEntry(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const mapName = String(values.map ?? '');
        const entryId = String(values.id ?? '');
        ctx.body = await client.deleteRuntimeMapEntry(mapName, entryId, values.forceSync !== false);
        await revisionAudit.recordAudit(ctx, {
          connectionId: Number(model.get('id')),
          connectionName: String(model.get('name')),
          category: 'runtime',
          action: 'deleteRuntimeMapEntry',
          target: `${mapName}:${entryId}`,
        });
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async listStickTables(ctx: Context, next: Next) {
      try {
        const { client } = await connectionManager.getClient(ctx.action?.params?.connectionId, true);
        ctx.body = await client.listStickTables();
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async getStickTableEntries(ctx: Context, next: Next) {
      try {
        const { client } = await connectionManager.getClient(ctx.action?.params?.connectionId, true);
        ctx.body = await client.getStickTableEntries(String(ctx.action?.params?.table ?? ''));
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    // --- Phase 1: Revisions, Visual Diff, Live Node Drift, Rollback & Audit Logs ---

    async listRevisions(ctx: Context, next: Next) {
      try {
        const connId = ctx.action?.params?.connectionId ? Number(ctx.action.params.connectionId) : undefined;
        ctx.body = await revisionAudit.listRevisions(connId);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async getRevision(ctx: Context, next: Next) {
      try {
        ctx.body = await revisionAudit.getRevisionDetail(ctx.action?.params?.revisionId);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async createSnapshot(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const connectionId = Number(model.get('id'));
        const connectionName = String(model.get('name'));
        const summary = values.summary ? String(values.summary) : null;
        const created = await revisionAudit.captureRevision({
          connectionId,
          connectionName,
          client,
          source: 'manual_snapshot',
          summary,
          ctx,
          deduplicate: false,
        });
        await revisionAudit.recordAudit(ctx, {
          connectionId,
          connectionName,
          category: 'config',
          action: 'createSnapshot',
          target: created ? `#${created.id}` : connectionName,
          detail: summary,
        });
        ctx.body = created;
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async diffRevisions(ctx: Context, next: Next) {
      try {
        const params = ctx.action?.params ?? {};
        ctx.body = await revisionAudit.diffRevisions({
          leftRevisionId: params.leftRevisionId,
          rightRevisionId: params.rightRevisionId,
          connectionId: params.connectionId,
        });
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async diffLiveNodes(ctx: Context, next: Next) {
      try {
        const params = ctx.action?.params ?? {};
        ctx.body = await revisionAudit.diffLiveNodes(params.leftConnectionId, params.rightConnectionId);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async rollbackRevision(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const targetModel = await revisionAudit.getRevisionModel(values.revisionId as number);
        const targetId = Number(targetModel.get('id'));
        const connectionId = Number(targetModel.get('connectionId'));
        const rawContent = String(targetModel.get('rawContent') ?? '');
        const { model, client } = await connectionManager.getClient(connectionId, true);
        const connectionName = String(model.get('name'));

        const meta = await client.pushRawConfig(rawContent, {
          forceReload: Boolean(values.forceReload),
          skipVersion: values.skipVersion !== false,
        });

        const snapshot = await revisionAudit.captureRevision({
          connectionId,
          connectionName,
          client,
          source: 'rollback',
          summary: `Rollback to revision #${targetId}`,
          ctx,
          deduplicate: false,
        });

        await revisionAudit.recordAudit(ctx, {
          connectionId,
          connectionName,
          category: 'raw',
          action: 'rollbackRevision',
          target: `#${targetId}`,
          detail: meta.reloadId ? `reloadId=${meta.reloadId}` : null,
        });

        ctx.body = { meta, revision: snapshot };
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async listAuditLogs(ctx: Context, next: Next) {
      try {
        const params = ctx.action?.params ?? {};
        ctx.body = await revisionAudit.listAuditLogs({
          connectionId: params.connectionId ? Number(params.connectionId) : undefined,
          category: params.category ? String(params.category) : undefined,
        });
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    // --- Configuration Version, Transactions & Reloads ---

    async getConfigVersion(ctx: Context, next: Next) {
      try {
        const { client } = await connectionManager.getClient(ctx.action?.params?.connectionId, true);
        const txId = ctx.action?.params?.transactionId ? String(ctx.action.params.transactionId) : undefined;
        ctx.body = { version: await client.getConfigVersion(txId) };
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async listTransactions(ctx: Context, next: Next) {
      try {
        const { client } = await connectionManager.getClient(ctx.action?.params?.connectionId, true);
        const statusRaw = ctx.action?.params?.status;
        const status = statusRaw === 'in_progress' || statusRaw === 'failed' ? statusRaw : undefined;
        ctx.body = await client.listTransactions(status);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async startTransaction(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const version = values.version != null ? Number(values.version) : undefined;
        const tx = await client.startTransaction(version);
        await revisionAudit.recordAudit(ctx, {
          connectionId: Number(model.get('id')),
          connectionName: String(model.get('name')),
          category: 'config',
          action: 'startTransaction',
          target: tx.id,
        });
        ctx.body = tx;
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async commitTransaction(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const connectionId = Number(model.get('id'));
        const connectionName = String(model.get('name'));
        const txId = String(values.transactionId ?? '');
        const res = await client.commitTransaction(txId, Boolean(values.forceReload));
        await revisionAudit.captureRevisionBestEffort({
          connectionId,
          connectionName,
          client,
          source: 'transaction_commit',
          summary: `Committed transaction ${txId.slice(0, 12)}`,
          ctx,
        });
        await revisionAudit.recordAudit(ctx, {
          connectionId,
          connectionName,
          category: 'config',
          action: 'commitTransaction',
          target: txId,
          detail: res.meta.reloadId ? `reloadId=${res.meta.reloadId}` : null,
        });
        ctx.body = res;
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async deleteTransaction(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const txId = String(values.transactionId ?? '');
        ctx.body = await client.deleteTransaction(txId);
        await revisionAudit.recordAudit(ctx, {
          connectionId: Number(model.get('id')),
          connectionName: String(model.get('name')),
          category: 'config',
          action: 'deleteTransaction',
          target: txId,
        });
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async listReloads(ctx: Context, next: Next) {
      try {
        const { client } = await connectionManager.getClient(ctx.action?.params?.connectionId, true);
        ctx.body = await client.listReloads();
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    // --- Raw haproxy.cfg & Multi-Server Config Sync ---

    async getRawConfig(ctx: Context, next: Next) {
      try {
        const { client } = await connectionManager.getClient(ctx.action?.params?.connectionId, true);
        const txId = ctx.action?.params?.transactionId ? String(ctx.action.params.transactionId) : undefined;
        ctx.body = await client.getRawConfig(txId);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async pushRawConfig(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const connectionId = Number(model.get('id'));
        const connectionName = String(model.get('name'));
        const meta = await client.pushRawConfig(String(values.content ?? ''), {
          version: values.version != null ? Number(values.version) : undefined,
          forceReload: Boolean(values.forceReload),
          skipVersion: Boolean(values.skipVersion),
        });
        await revisionAudit.captureRevisionBestEffort({
          connectionId,
          connectionName,
          client,
          source: 'raw_push',
          summary: 'Direct raw haproxy.cfg push',
          ctx,
        });
        await revisionAudit.recordAudit(ctx, {
          connectionId,
          connectionName,
          category: 'raw',
          action: 'pushRawConfig',
          target: connectionName,
          detail: meta.reloadId ? `reloadId=${meta.reloadId}` : null,
        });
        ctx.body = meta;
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async pushRawConfigBatch(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const content = String(values.content ?? '');
        if (!content.trim()) {
          throw new DataplaneApiError('Raw HAProxy configuration cannot be empty', 400);
        }
        const targetIds = parseTargetIds(values.targetConnectionIds);
        const forceReload = Boolean(values.forceReload);
        const skipVersion = Boolean(values.skipVersion);

        const results = await mapWithConcurrency(targetIds, 4, async (targetId): Promise<BatchSyncItemResult> => {
          try {
            const { model, client } = await connectionManager.getClient(targetId, true);
            const connectionName = String(model.get('name'));
            const meta = await client.pushRawConfig(content, { forceReload, skipVersion });
            await revisionAudit.captureRevisionBestEffort({
              connectionId: targetId,
              connectionName,
              client,
              source: 'batch_sync',
              summary: 'Multi-server raw haproxy.cfg sync',
              ctx,
            });
            await revisionAudit.recordAudit(ctx, {
              connectionId: targetId,
              connectionName,
              category: 'raw',
              action: 'pushRawConfigBatch',
              target: connectionName,
              detail: meta.reloadId ? `reloadId=${meta.reloadId}` : null,
            });
            return {
              connectionId: targetId,
              connectionName,
              ok: true,
              status: meta.status,
              version: meta.configurationVersion,
              reloadId: meta.reloadId,
            };
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await revisionAudit.recordAudit(ctx, {
              connectionId: targetId,
              connectionName: `#${targetId}`,
              category: 'raw',
              action: 'pushRawConfigBatch',
              target: `#${targetId}`,
              status: 'failed',
              detail: errMsg,
            });
            return {
              connectionId: targetId,
              connectionName: `#${targetId}`,
              ok: false,
              error: errMsg,
            };
          }
        });
        ctx.body = { results };
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    // --- Structured Configuration: Frontends, Binds, ACLs, Routing & HTTP Rules ---

    async listFrontends(ctx: Context, next: Next) {
      try {
        const { client } = await connectionManager.getClient(ctx.action?.params?.connectionId, true);
        const txId = ctx.action?.params?.transactionId ? String(ctx.action.params.transactionId) : undefined;
        ctx.body = await client.listFrontends(txId);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async createFrontend(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const opts = parseWriteOptions(values);
        const fe = (values.frontend ?? {}) as HaproxyFrontendConfig;
        ctx.body = await client.createFrontend(fe, opts);
        await afterStructuredWrite(ctx, model, client, opts, 'createFrontend', String(fe.name ?? ''));
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async updateFrontend(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const opts = parseWriteOptions(values);
        const name = String(values.name ?? '');
        ctx.body = await client.updateFrontend(name, (values.frontend ?? {}) as HaproxyFrontendConfig, opts);
        await afterStructuredWrite(ctx, model, client, opts, 'updateFrontend', name);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async deleteFrontend(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const opts = parseWriteOptions(values);
        const name = String(values.name ?? '');
        ctx.body = await client.deleteFrontend(name, opts);
        await afterStructuredWrite(ctx, model, client, opts, 'deleteFrontend', name);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async listBinds(ctx: Context, next: Next) {
      try {
        const { client } = await connectionManager.getClient(ctx.action?.params?.connectionId, true);
        const txId = ctx.action?.params?.transactionId ? String(ctx.action.params.transactionId) : undefined;
        ctx.body = await client.listBinds(String(ctx.action?.params?.frontend ?? ''), txId);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async createBind(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const opts = parseWriteOptions(values);
        const fe = String(values.frontend ?? '');
        const bind = (values.bind ?? {}) as HaproxyBindConfig;
        ctx.body = await client.createBind(fe, bind, opts);
        await afterStructuredWrite(ctx, model, client, opts, 'createBind', `${fe}/${String(bind.name ?? '')}`);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async updateBind(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const opts = parseWriteOptions(values);
        const fe = String(values.frontend ?? '');
        const name = String(values.name ?? '');
        ctx.body = await client.updateBind(fe, name, (values.bind ?? {}) as HaproxyBindConfig, opts);
        await afterStructuredWrite(ctx, model, client, opts, 'updateBind', `${fe}/${name}`);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async deleteBind(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const opts = parseWriteOptions(values);
        const fe = String(values.frontend ?? '');
        const name = String(values.name ?? '');
        ctx.body = await client.deleteBind(fe, name, opts);
        await afterStructuredWrite(ctx, model, client, opts, 'deleteBind', `${fe}/${name}`);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async listFrontendAcls(ctx: Context, next: Next) {
      try {
        const { client } = await connectionManager.getClient(ctx.action?.params?.connectionId, true);
        const txId = ctx.action?.params?.transactionId ? String(ctx.action.params.transactionId) : undefined;
        ctx.body = await client.listFrontendAcls(String(ctx.action?.params?.frontend ?? ''), txId);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async replaceFrontendAcls(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const opts = parseWriteOptions(values);
        const fe = String(values.frontend ?? '');
        const acls = Array.isArray(values.acls) ? (values.acls as HaproxyAclConfig[]) : [];
        ctx.body = await client.replaceFrontendAcls(fe, acls, opts);
        await afterStructuredWrite(ctx, model, client, opts, 'replaceFrontendAcls', fe);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async listBackendSwitchingRules(ctx: Context, next: Next) {
      try {
        const { client } = await connectionManager.getClient(ctx.action?.params?.connectionId, true);
        const txId = ctx.action?.params?.transactionId ? String(ctx.action.params.transactionId) : undefined;
        ctx.body = await client.listBackendSwitchingRules(String(ctx.action?.params?.frontend ?? ''), txId);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async replaceBackendSwitchingRules(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const opts = parseWriteOptions(values);
        const fe = String(values.frontend ?? '');
        const rules = Array.isArray(values.rules) ? (values.rules as HaproxyBackendSwitchingRule[]) : [];
        ctx.body = await client.replaceBackendSwitchingRules(fe, rules, opts);
        await afterStructuredWrite(ctx, model, client, opts, 'replaceBackendSwitchingRules', fe);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async listFrontendHttpRequestRules(ctx: Context, next: Next) {
      try {
        const { client } = await connectionManager.getClient(ctx.action?.params?.connectionId, true);
        const txId = ctx.action?.params?.transactionId ? String(ctx.action.params.transactionId) : undefined;
        ctx.body = await client.listFrontendHttpRequestRules(String(ctx.action?.params?.frontend ?? ''), txId);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async replaceFrontendHttpRequestRules(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const opts = parseWriteOptions(values);
        const fe = String(values.frontend ?? '');
        const rules = Array.isArray(values.rules) ? (values.rules as HaproxyHttpRequestRule[]) : [];
        ctx.body = await client.replaceFrontendHttpRequestRules(fe, rules, opts);
        await afterStructuredWrite(ctx, model, client, opts, 'replaceFrontendHttpRequestRules', fe);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    // --- Structured Configuration: Backends & Permanent Backend Servers ---

    async listBackends(ctx: Context, next: Next) {
      try {
        const { client } = await connectionManager.getClient(ctx.action?.params?.connectionId, true);
        const txId = ctx.action?.params?.transactionId ? String(ctx.action.params.transactionId) : undefined;
        ctx.body = await client.listBackends(txId);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async createBackend(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const opts = parseWriteOptions(values);
        const be = (values.backend ?? {}) as HaproxyBackendConfig;
        ctx.body = await client.createBackend(be, opts);
        await afterStructuredWrite(ctx, model, client, opts, 'createBackend', String(be.name ?? ''));
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async updateBackend(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const opts = parseWriteOptions(values);
        const name = String(values.name ?? '');
        ctx.body = await client.updateBackend(name, (values.backend ?? {}) as HaproxyBackendConfig, opts);
        await afterStructuredWrite(ctx, model, client, opts, 'updateBackend', name);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async deleteBackend(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const opts = parseWriteOptions(values);
        const name = String(values.name ?? '');
        ctx.body = await client.deleteBackend(name, opts);
        await afterStructuredWrite(ctx, model, client, opts, 'deleteBackend', name);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async listBackendServers(ctx: Context, next: Next) {
      try {
        const { client } = await connectionManager.getClient(ctx.action?.params?.connectionId, true);
        const txId = ctx.action?.params?.transactionId ? String(ctx.action.params.transactionId) : undefined;
        ctx.body = await client.listBackendServers(String(ctx.action?.params?.backend ?? ''), txId);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async createBackendServer(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const opts = parseWriteOptions(values);
        const be = String(values.backend ?? '');
        const srv = (values.server ?? {}) as HaproxyServerConfig;
        ctx.body = await client.createBackendServer(be, srv, opts);
        await afterStructuredWrite(ctx, model, client, opts, 'createBackendServer', `${be}/${String(srv.name ?? '')}`);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async updateBackendServer(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const opts = parseWriteOptions(values);
        const be = String(values.backend ?? '');
        const name = String(values.name ?? '');
        ctx.body = await client.updateBackendServer(be, name, (values.server ?? {}) as HaproxyServerConfig, opts);
        await afterStructuredWrite(ctx, model, client, opts, 'updateBackendServer', `${be}/${name}`);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async deleteBackendServer(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const opts = parseWriteOptions(values);
        const be = String(values.backend ?? '');
        const name = String(values.name ?? '');
        ctx.body = await client.deleteBackendServer(be, name, opts);
        await afterStructuredWrite(ctx, model, client, opts, 'deleteBackendServer', `${be}/${name}`);
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    // --- Managed Storage (SSL Certificates, Maps, General Files) & Multi-Server SSL Sync ---

    async listSslCertificates(ctx: Context, next: Next) {
      try {
        const { client } = await connectionManager.getClient(ctx.action?.params?.connectionId, true);
        ctx.body = await client.listSslCertificates();
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async uploadSslCertificate(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const fileName = String(values.fileName ?? '');
        ctx.body = await client.uploadSslCertificate(
          fileName,
          String(values.pemContent ?? ''),
          parseStorageOptions(values),
        );
        await revisionAudit.recordAudit(ctx, {
          connectionId: Number(model.get('id')),
          connectionName: String(model.get('name')),
          category: 'storage',
          action: 'uploadSslCertificate',
          target: fileName,
        });
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async replaceSslCertificate(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const storageName = String(values.storageName ?? '');
        ctx.body = await client.replaceSslCertificate(
          storageName,
          String(values.pemContent ?? ''),
          parseStorageOptions(values),
        );
        await revisionAudit.recordAudit(ctx, {
          connectionId: Number(model.get('id')),
          connectionName: String(model.get('name')),
          category: 'storage',
          action: 'replaceSslCertificate',
          target: storageName,
        });
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async deleteSslCertificate(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const storageName = String(values.storageName ?? '');
        ctx.body = await client.deleteSslCertificate(storageName, parseStorageOptions(values));
        await revisionAudit.recordAudit(ctx, {
          connectionId: Number(model.get('id')),
          connectionName: String(model.get('name')),
          category: 'storage',
          action: 'deleteSslCertificate',
          target: storageName,
        });
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async syncSslCertificateBatch(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const fileName = String(values.fileName ?? '').trim();
        const pemContent = String(values.pemContent ?? '');
        if (!pemContent.trim()) {
          throw new DataplaneApiError('PEM certificate bundle cannot be empty', 400);
        }
        const targetIds = parseTargetIds(values.targetConnectionIds);
        const storageOpts = parseStorageOptions(values);

        const results = await mapWithConcurrency(targetIds, 4, async (targetId): Promise<BatchSyncItemResult> => {
          try {
            const { model, client } = await connectionManager.getClient(targetId, true);
            const connectionName = String(model.get('name'));
            const existing = await client.listSslCertificates();
            const alreadyExists = existing.some((c) => c.storage_name === fileName);
            const res = alreadyExists
              ? await client.replaceSslCertificate(fileName, pemContent, storageOpts)
              : await client.uploadSslCertificate(fileName, pemContent, storageOpts);
            await revisionAudit.recordAudit(ctx, {
              connectionId: targetId,
              connectionName,
              category: 'storage',
              action: 'syncSslCertificateBatch',
              target: fileName,
            });
            return {
              connectionId: targetId,
              connectionName,
              ok: true,
              status: res.meta.status,
              reloadId: res.meta.reloadId,
            };
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await revisionAudit.recordAudit(ctx, {
              connectionId: targetId,
              connectionName: `#${targetId}`,
              category: 'storage',
              action: 'syncSslCertificateBatch',
              target: fileName,
              status: 'failed',
              detail: errMsg,
            });
            return {
              connectionId: targetId,
              connectionName: `#${targetId}`,
              ok: false,
              error: errMsg,
            };
          }
        });
        ctx.body = { results };
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async listStorageMaps(ctx: Context, next: Next) {
      try {
        const { client } = await connectionManager.getClient(ctx.action?.params?.connectionId, true);
        ctx.body = await client.listStorageMaps();
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async getStorageMapContent(ctx: Context, next: Next) {
      try {
        const { client } = await connectionManager.getClient(ctx.action?.params?.connectionId, true);
        const storageName = String(ctx.action?.params?.storageName ?? '');
        ctx.body = { storageName, content: await client.getStorageMapContent(storageName) };
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async createStorageMap(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const fileName = String(values.fileName ?? '');
        ctx.body = await client.createStorageMap(fileName, String(values.content ?? ''));
        await revisionAudit.recordAudit(ctx, {
          connectionId: Number(model.get('id')),
          connectionName: String(model.get('name')),
          category: 'storage',
          action: 'createStorageMap',
          target: fileName,
        });
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async replaceStorageMap(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const storageName = String(values.storageName ?? '');
        ctx.body = await client.replaceStorageMap(
          storageName,
          String(values.content ?? ''),
          parseStorageOptions(values),
        );
        await revisionAudit.recordAudit(ctx, {
          connectionId: Number(model.get('id')),
          connectionName: String(model.get('name')),
          category: 'storage',
          action: 'replaceStorageMap',
          target: storageName,
        });
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async deleteStorageMap(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const storageName = String(values.storageName ?? '');
        ctx.body = await client.deleteStorageMap(storageName);
        await revisionAudit.recordAudit(ctx, {
          connectionId: Number(model.get('id')),
          connectionName: String(model.get('name')),
          category: 'storage',
          action: 'deleteStorageMap',
          target: storageName,
        });
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async listStorageGeneralFiles(ctx: Context, next: Next) {
      try {
        const { client } = await connectionManager.getClient(ctx.action?.params?.connectionId, true);
        ctx.body = await client.listStorageGeneralFiles();
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async getStorageGeneralFileContent(ctx: Context, next: Next) {
      try {
        const { client } = await connectionManager.getClient(ctx.action?.params?.connectionId, true);
        const storageName = String(ctx.action?.params?.storageName ?? '');
        ctx.body = { storageName, content: await client.getStorageGeneralFileContent(storageName) };
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async createStorageGeneralFile(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const fileName = String(values.fileName ?? '');
        ctx.body = await client.createStorageGeneralFile(fileName, String(values.content ?? ''));
        await revisionAudit.recordAudit(ctx, {
          connectionId: Number(model.get('id')),
          connectionName: String(model.get('name')),
          category: 'storage',
          action: 'createStorageGeneralFile',
          target: fileName,
        });
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async replaceStorageGeneralFile(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const storageName = String(values.storageName ?? '');
        ctx.body = await client.replaceStorageGeneralFile(
          storageName,
          String(values.content ?? ''),
          parseStorageOptions(values),
        );
        await revisionAudit.recordAudit(ctx, {
          connectionId: Number(model.get('id')),
          connectionName: String(model.get('name')),
          category: 'storage',
          action: 'replaceStorageGeneralFile',
          target: storageName,
        });
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },

    async deleteStorageGeneralFile(ctx: Context, next: Next) {
      try {
        const values = extractValues(ctx);
        const { model, client } = await connectionManager.getClient(values.connectionId as number, true);
        const storageName = String(values.storageName ?? '');
        ctx.body = await client.deleteStorageGeneralFile(storageName);
        await revisionAudit.recordAudit(ctx, {
          connectionId: Number(model.get('id')),
          connectionName: String(model.get('name')),
          category: 'storage',
          action: 'deleteStorageGeneralFile',
          target: storageName,
        });
      } catch (error) {
        handleActionError(ctx, error);
      }
      await next();
    },
  };
}
