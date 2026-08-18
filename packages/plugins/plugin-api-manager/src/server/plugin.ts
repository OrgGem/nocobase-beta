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
} from '../constants';
import { createApimRouter } from './gateway/router';
import { registerApiKeysResource } from './resources/api-keys';
import { registerRoutesResource } from './resources/routes';
import { pruneExpiredLogs } from './services/request-logger';

const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function toPlainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { toJSON?: () => Record<string, unknown> };
  if (typeof candidate.toJSON === 'function') return candidate.toJSON();
  return { ...(value as Record<string, unknown>) };
}

function maskAesSecret(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(maskAesSecret);
  if (!body || typeof body !== 'object') return body;
  const obj = body as Record<string, unknown>;
  if (Array.isArray(obj.rows)) {
    return { ...obj, rows: obj.rows.map(maskAesSecret) };
  }
  const plain = toPlainRecord(obj);
  if (plain && 'aesSecret' in plain && plain.aesSecret) {
    plain.aesSecret = MASK;
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
    this.db.on('apiRoutes.beforeSave', async (model: Model) => {
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

      if (!model.changed('aesSecret')) return;
      const secret = model.get('aesSecret');
      if (secret === MASK) {
        if (model.isNewRecord) {
          model.set('aesSecret', null);
        } else {
          const existing = await this.db.getRepository('apiRoutes').findOne({ filterByTk: model.get('id') });
          model.set('aesSecret', existing ? existing.get('aesSecret') : null);
        }
        return;
      }
      if (secret == null || secret === '') {
        model.set('aesSecret', null);
        return;
      }
      model.set('aesSecret', await this.app.aesEncryptor.encrypt(String(secret)));
    });
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

    this.app.use(createApimRouter(this.app), { after: 'idp-oauth-resource-auth', before: 'resourcer' });

    registerApiKeysResource(this.app);
    registerRoutesResource(this.app);

    // Mask secrets in admin API responses without affecting internal reads.
    this.app.resourceManager.use(async (ctx, next) => {
      await next();
      const resourceName = ctx.action?.resourceName;
      if (resourceName === 'apiRoutes') {
        ctx.body = maskAesSecret(ctx.body);
      } else if (resourceName === 'apiManagerApiKeys') {
        ctx.body = stripKeyHash(ctx.body);
      }
    });

    this.app.acl.registerSnippet({
      name: APIM_ACL,
      actions: ['apiRoutes:*', 'apiPartners:*', 'apiManagerApiKeys:*', 'apiRequestLogs:list', 'apiRequestLogs:get'],
    });

    this.app.on('afterStart', () => {
      this.pruneLogs();
      this.pruneTimer = setInterval(() => this.pruneLogs(), PRUNE_INTERVAL_MS);
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
