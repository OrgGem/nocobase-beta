import path from 'path';
import type { Model } from '@nocobase/database';
import { Plugin } from '@nocobase/server';
import {
  APIM_ACL,
  APIM_PREFIX,
  DEFAULT_LOG_RETENTION_DAYS,
  MASK,
  MAX_MAX_BODY_MB,
  MAX_RETRY_COUNT,
  MAX_RETRY_DELAY_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  ROUTE_NAME_PATTERN,
} from '../constants';
import { createApimRouter, type ApimRuntimeState } from './gateway/router';
import { CapacityLimiter } from './services/capacity-limiter';
import { CircuitBreaker } from './services/circuit-breaker';
import { registerHealthResource } from './resources/health';
import { registerApiKeysResource } from './resources/api-keys';
import { registerRoutesResource } from './resources/routes';
import { registerApiManagerSettingsResource } from './resources/settings';
import { pruneExpiredLogs } from './services/request-logger';
import { runWithDistributedLock } from './services/ha-lock';
import { registerRouteSnippets, registerAllRoutesSnippet, syncApimRoutesAvailableActions } from './services/acl';

const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function toPlainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { toJSON?: () => Record<string, unknown> };
  if (typeof candidate.toJSON === 'function') return candidate.toJSON();
  return { ...(value as Record<string, unknown>) };
}

const SECRET_FIELDS = ['aesSecret', 'hmacSecret', 'jwtSecret'];

/**
 * inboundPath is appended to /api/apim/inbound/ to form the public URL, so it
 * must stay a plain relative path: no leading slash, no query/fragment/whitespace,
 * and no "."/".."/empty segments.
 */
function assertValidInboundPath(inboundPath: string): void {
  if (inboundPath.startsWith('/')) {
    throw new Error('inboundPath must not start with "/"');
  }
  if (/[\s?#]/.test(inboundPath)) {
    throw new Error('inboundPath must not contain whitespace, "?" or "#"');
  }
  for (const segment of inboundPath.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`inboundPath "${inboundPath}" contains an invalid path segment`);
    }
  }
}

function maskSecrets(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(maskSecrets);
  if (!body || typeof body !== 'object') return body;
  const obj = body as Record<string, unknown>;
  if (Array.isArray(obj.rows)) {
    return { ...obj, rows: obj.rows.map(maskSecrets) };
  }
  const plain = toPlainRecord(obj);
  if (plain) {
    for (const field of SECRET_FIELDS) {
      if (field in plain && plain[field]) {
        plain[field] = MASK;
      }
    }
  }
  return plain ?? obj;
}

function stripKeyHash(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(stripKeyHash);
  if (!body || typeof body !== 'object') return body;
  const obj = body as Record<string, unknown>;
  if (Array.isArray(obj.rows)) {
    return { ...obj, rows: obj.rows.map(stripKeyHash) };
  }
  const plain = toPlainRecord(obj);
  if (plain && 'keyHash' in plain) {
    delete plain.keyHash;
  }
  return plain ?? obj;
}

export class PluginApiManagerServer extends Plugin {
  private pruneTimer?: NodeJS.Timeout;

  async beforeLoad() {
    this.db.addMigrations({
      namespace: this.name,
      directory: path.resolve(__dirname, 'migrations'),
      context: {
        plugin: this,
      },
    });

    this.db.on('apiRoutes.beforeSave', async (model: Model) => {
      // Partner is mandatory: every route must belong to exactly one partner so
      // the gateway can enforce tenant isolation between routes and callers.
      const routePartnerId =
        model.get('partnerId') == null || model.get('partnerId') === '' ? null : Number(model.get('partnerId'));
      if (routePartnerId == null || !Number.isFinite(routePartnerId) || routePartnerId <= 0) {
        throw new Error('partnerId is required for a route');
      }
      const name = String(model.get('name') ?? '');
      if (!ROUTE_NAME_PATTERN.test(name)) {
        throw new Error('Route name may only contain letters, numbers, ".", "_" and "-"');
      }

      // Validate authMode: 'both' | 'api-key' | 'role'; anything else falls
      // back to 'both' so legacy routes keep accepting both credential types.
      const authModeRaw = String(model.get('authMode') ?? 'both');
      model.set('authMode', authModeRaw === 'api-key' || authModeRaw === 'role' ? authModeRaw : 'both');

      const targetUrl = model.get('targetUrl');
      if (targetUrl != null && targetUrl !== '' && !/^https?:\/\//i.test(String(targetUrl))) {
        throw new Error('targetUrl must start with http:// or https://');
      }

      const retryCount = Number(model.get('retryCount'));
      if (Number.isFinite(retryCount)) {
        model.set('retryCount', Math.min(MAX_RETRY_COUNT, Math.max(0, Math.round(retryCount))));
      }
      const maxBodyMb = Number(model.get('maxBodyMb'));
      if (Number.isFinite(maxBodyMb)) {
        model.set('maxBodyMb', Math.min(MAX_MAX_BODY_MB, Math.max(1, Math.round(maxBodyMb))));
      }

      const direction = String(model.get('direction') ?? 'outbound');
      if (direction === 'inbound') {
        const inboundPath = String(model.get('inboundPath') ?? '').trim();
        if (!inboundPath) {
          throw new Error('inboundPath is required for inbound routes');
        }
        assertValidInboundPath(inboundPath);
        model.set('inboundPath', inboundPath);
        const existing = await this.db
          .getRepository('apiRoutes')
          .findOne({ filter: { direction: 'inbound', inboundPath } });
        const existingId = existing ? Number(existing.get('id')) : null;
        const currentId = model.get('id') == null ? null : Number(model.get('id'));
        if (existingId != null && existingId !== currentId) {
          throw new Error(
            `inboundPath "${inboundPath}" is already used by inbound route "${String(existing?.get('name'))}"`,
          );
        }
      }

      await this.normalizeSecretField(model, 'aesSecret');
      await this.normalizeSecretField(model, 'hmacSecret');
      await this.normalizeSecretField(model, 'jwtSecret');

      // Clamp the new security knobs to sane ranges.
      this.clampIntegerField(model, 'timeoutMs', MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      this.clampIntegerField(model, 'retryDelayMs', 0, MAX_RETRY_DELAY_MS);
      this.clampIntegerField(model, 'hmacToleranceSec', 1, 3600);
      this.clampIntegerField(model, 'jwtExpiresInSec', 1, 86400);
      this.clampIntegerField(model, 'rateLimitMax', 1, 100000);
      this.clampIntegerField(model, 'rateLimitWindowSec', 1, 86400);

      // Drop HMAC/JWT fields that no longer apply so stale secrets cannot resurrect.
      if (!model.get('hmacSignEnabled') && !model.get('hmacVerifyEnabled')) {
        for (const field of ['hmacSecret', 'hmacSecretEnvVar']) {
          if (model.get(field) != null && model.get(field) !== '') model.set(field, null);
        }
      }
      if (!model.get('jwtSignEnabled')) {
        for (const field of ['jwtSignKeyName']) {
          if (model.get(field) != null && model.get(field) !== '') model.set(field, null);
        }
      }
      if (!model.get('jwtVerifyEnabled')) {
        for (const field of ['jwtVerifyKeyName']) {
          if (model.get(field) != null && model.get(field) !== '') model.set(field, null);
        }
      }
      if (!model.get('jwtSignEnabled') && !model.get('jwtVerifyEnabled')) {
        for (const field of ['jwtSecret', 'jwtSecretEnvVar', 'jwtIssuer', 'jwtAudience']) {
          if (model.get(field) != null && model.get(field) !== '') model.set(field, null);
        }
      }
      // Drop mode-specific fields that no longer apply so stale secrets or key
      // names cannot silently resurrect when the mode is switched back.
      const mode = String(model.get('encryptionMode') ?? 'none');
      if (mode !== 'aes-256-gcm') {
        if (model.get('aesSecret') != null) model.set('aesSecret', null);
        if (model.get('aesSecretEnvVar') != null && model.get('aesSecretEnvVar') !== '') {
          model.set('aesSecretEnvVar', null);
        }
      }
      if (mode !== 'pgp') {
        for (const field of ['pgpEncryptKeyName', 'pgpDecryptKeyName', 'pgpSignKeyName', 'pgpVerifyKeyName']) {
          if (model.get(field) != null && model.get(field) !== '') model.set(field, null);
        }
      }
      if (mode !== 'rsa-oaep') {
        for (const field of ['rsaEncryptKeyName', 'rsaDecryptKeyName']) {
          if (model.get(field) != null && model.get(field) !== '') model.set(field, null);
        }
      }

      // responseEncrypted defaults to true; only an explicit false disables
      // response crypto (outbound response decrypt / inbound response encrypt).
      const responseEncrypted = model.get('responseEncrypted') !== false;

      if (mode === 'aes-256-gcm') {
        const hasEnvVar = String(model.get('aesSecretEnvVar') ?? '').trim() !== '';
        const hasSecret = String(model.get('aesSecret') ?? '').trim() !== '';
        if (!hasEnvVar && !hasSecret) {
          throw new Error('AES-256-GCM routes require a shared secret: set aesSecret or aesSecretEnvVar');
        }
      }
      if (mode === 'pgp') {
        const hasEncryptKey = String(model.get('pgpEncryptKeyName') ?? '').trim() !== '';
        const hasDecryptKey = String(model.get('pgpDecryptKeyName') ?? '').trim() !== '';
        const needsEncryptKey = direction === 'outbound' || responseEncrypted;
        const needsDecryptKey = direction === 'inbound' || responseEncrypted;
        if (needsEncryptKey && !hasEncryptKey) {
          throw new Error('PGP routes require pgpEncryptKeyName (recipient public key)');
        }
        if (needsDecryptKey && !hasDecryptKey) {
          throw new Error('PGP routes require pgpDecryptKeyName (own key with private material)');
        }
      }
      if (mode === 'rsa-oaep') {
        const hasEncryptKey = String(model.get('rsaEncryptKeyName') ?? '').trim() !== '';
        const hasDecryptKey = String(model.get('rsaDecryptKeyName') ?? '').trim() !== '';
        if (direction === 'outbound') {
          if (!hasEncryptKey) {
            throw new Error('RSA routes require rsaEncryptKeyName (partner RSA public key)');
          }
          if (responseEncrypted && !hasDecryptKey) {
            throw new Error(
              'RSA routes require rsaDecryptKeyName (own key with private material) when the response is encrypted',
            );
          }
        } else {
          if (!hasDecryptKey) {
            throw new Error('RSA routes require rsaDecryptKeyName (own key with private material)');
          }
          if (responseEncrypted && !hasEncryptKey) {
            throw new Error(
              'RSA routes require rsaEncryptKeyName (partner RSA public key) when the response is encrypted',
            );
          }
        }
      }
    });
  }

  private async normalizeSecretField(model: Model, field: string) {
    if (!model.changed(field)) return;
    const secret = model.get(field);
    if (secret === MASK) {
      if (model.isNewRecord) {
        model.set(field, null);
      } else {
        const existing = await this.db.getRepository('apiRoutes').findOne({ filterByTk: model.get('id') });
        model.set(field, existing ? existing.get(field) : null);
      }
      return;
    }
    if (secret == null || secret === '') {
      model.set(field, null);
      return;
    }
    model.set(field, await this.app.aesEncryptor.encrypt(String(secret)));
  }

  private clampIntegerField(model: Model, field: string, min: number, max: number) {
    const value = Number(model.get(field));
    if (Number.isFinite(value)) {
      model.set(field, Math.min(max, Math.max(min, Math.round(value))));
    }
  }

  async load() {
    this.db.import({ directory: path.resolve(__dirname, 'collections') });

    // Disable the core koa-bodyparser for gateway paths so raw binary bodies can be
    // read and capped by the route's own maxBodyMb setting.
    this.app.use(
      async (ctx, next) => {
        if (ctx.path.startsWith(APIM_PREFIX)) {
          (ctx as { disableBodyParser?: boolean }).disableBodyParser = true;
        }
        await next();
      },
      { tag: 'apimDisableBodyParser', before: 'bodyParser' },
    );

    const runtime: ApimRuntimeState = {
      capacityLimiter: new CapacityLimiter({
        maxConcurrentRequests: 50,
        maxTotalBytes: 512 * 1024 * 1024,
        maxRequestBytes: 0,
        queueEnabled: true,
        queueSize: 1000,
        queueTimeoutMs: 30_000,
      }),
      circuitBreaker: new CircuitBreaker(),
    };

        // Runs before the dataSource middleware so gateway requests never enter the
    // resourcer pipeline (no resource parsing, no ACL middleware, no data
    // wrapping). 'resourcer' is not an app-level middleware tag — the resourcer
    // runs inside the dataSource middleware — so anchor on 'dataSource' instead.
    this.app.use(createApimRouter(this.app, runtime), { after: 'idp-oauth-resource-auth', before: 'dataSource' });

    registerHealthResource(this.app, runtime);
    registerApiKeysResource(this.app);
    registerRoutesResource(this.app);
    registerApiManagerSettingsResource(this.app);

    // Mask secrets in admin API responses without affecting internal reads.
    this.app.resourceManager.use(async (ctx, next) => {
      await next();
      const resourceName = ctx.action?.resourceName;
      if (resourceName === 'apiRoutes') {
        ctx.body = maskSecrets(ctx.body);
      } else if (resourceName === 'apiManagerApiKeys') {
        ctx.body = stripKeyHash(ctx.body);
      }
    });

    this.app.acl.registerSnippet({
      name: APIM_ACL,
      actions: [
        'apiRoutes:*',
        'apiPartners:*',
        'apiPartnerRoles:*',
        'apiManagerApiKeys:*',
        'apiRequestLogs:list',
        'apiRequestLogs:get',
        'apiManagerSettings:get',
        'apiManagerSettings:save',
        'apiManager:health',
      ],
    });

    // Register per-route ACL snippets so a role granted
    // "pm.plugin-api-manager.routes.<routeName>" may call that route, and
    // advertise the synthetic apimRoutes resource actions to the Roles UI
    // (plugin-acl availableActions). The initial sync runs after start when
    // the tables are guaranteed to exist; re-runs whenever routes change.
    const syncRouteAcl = async () => {
      try {
        const repo = this.db.getRepository('apiRoutes');
        const routes = await repo.find({ filter: { enabled: true } });
        const routeNames = routes.map((route) => String(route.get('name') ?? '')).filter(Boolean);
        registerRouteSnippets(this.app.acl, routeNames);
        registerAllRoutesSnippet(this.app.acl);
        syncApimRoutesAvailableActions(this.app.acl, routeNames);
      } catch (error) {
        this.log.warn(`[api-manager] route ACL sync skipped: ${(error as Error).message ?? error}`);
      }
    };
    this.app.on('afterStart', async () => {
      await syncRouteAcl();
    });
    this.db.on('apiRoutes.afterSave', async () => {
      await syncRouteAcl();
    });
    this.db.on('apiRoutes.afterDestroy', async () => {
      await syncRouteAcl();
    });

    this.app.on('afterStart', () => {
      this.pruneLogs();
      this.pruneTimer = runWithDistributedLock(
        this.app,
        'api-manager:prune-logs',
        async () => this.pruneLogs(),
        PRUNE_INTERVAL_MS,
      );
    });
    this.app.on('beforeStop', () => {
      if (this.pruneTimer) {
        clearInterval(this.pruneTimer);
        this.pruneTimer = undefined;
      }
    });
  }

  private async pruneLogs() {
    try {
      await pruneExpiredLogs(this.db, DEFAULT_LOG_RETENTION_DAYS);
    } catch (error) {
      this.log.warn(`[api-manager] failed to prune apiRequestLogs: ${(error as Error).message}`);
    }
  }
}

export default PluginApiManagerServer;
