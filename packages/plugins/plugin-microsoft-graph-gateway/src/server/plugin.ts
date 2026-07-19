import { createHash, randomBytes } from 'node:crypto';
import { Plugin } from '@nocobase/server';
import type { Context, Next } from '@nocobase/actions';
import type { Model } from '@nocobase/database';
import { createGraphClient, GraphSettings } from './graph-client';

type RequestContext = Context;
type Scope = 'email:read' | 'email:write' | 'lists:read' | 'lists:write' | 'drive:read' | 'drive:write';

const hashKey = (value: string) => createHash('sha256').update(value).digest('hex');
const payloadOf = (ctx: RequestContext): Record<string, unknown> =>
  (ctx.action.params.values ?? ctx.request.body ?? {}) as Record<string, unknown>;
const pageSizeOf = (value: unknown) => Math.min(Math.max(Number(value ?? 50) || 50, 1), 100);

export class PluginMicrosoftGraphGatewayServer extends Plugin {
  private clients = new Map<string, ReturnType<typeof createGraphClient>>();

  async beforeLoad() {
    this.db.on('msGraphGatewaySettings.beforeSave', async (model: Model) => {
      if (!model.changed('clientSecret')) return;
      const clientSecret = model.get('clientSecret');
      if (!clientSecret) return;
      model.set('clientSecret', await this.app.aesEncryptor.encrypt(String(clientSecret)));
    });
  }

  async load() {
    this.app.resourceManager.define({
      name: 'msGraphGateway',
      actions: {
        createApiKey: async (ctx: Context, next: Next) => {
          await this.createApiKey(ctx);
          await next();
        },
        sendEmail: async (ctx: Context, next: Next) => {
          await this.enqueue(ctx, 'sendEmail', 'email:write');
          await next();
        },
        getJob: async (ctx: Context, next: Next) => {
          await this.getJob(ctx);
          await next();
        },
        retryJob: async (ctx: Context, next: Next) => {
          await this.retryJob(ctx);
          await next();
        },
        listMessages: async (ctx: Context, next: Next) => {
          await this.listMessages(ctx);
          await next();
        },
        listItems: async (ctx: Context, next: Next) => {
          await this.listItems(ctx);
          await next();
        },
        listDriveItems: async (ctx: Context, next: Next) => {
          await this.listDriveItems(ctx);
          await next();
        },
      },
    });
    // Gateway calls authenticate with X-API-Key; requiring a NocoBase session
    // here would make the integration unusable by external workers.
    this.app.acl.allow(
      'msGraphGateway',
      ['sendEmail', 'getJob', 'retryJob', 'listMessages', 'listItems', 'listDriveItems'],
      'public',
    );
    this.app.acl.allow('msGraphGateway', 'createApiKey', 'loggedIn');
  }

  private async createApiKey(ctx: RequestContext) {
    const values = payloadOf(ctx);
    const plain = `mgk_${randomBytes(24).toString('base64url')}`;
    const allowedScopes: Scope[] = [
      'email:read',
      'email:write',
      'lists:read',
      'lists:write',
      'drive:read',
      'drive:write',
    ];
    const scopes = Array.isArray(values.scopes)
      ? values.scopes
      : ['email:read', 'email:write', 'lists:read', 'drive:read'];
    if (!scopes.every((scope): scope is Scope => typeof scope === 'string' && allowedScopes.includes(scope as Scope))) {
      ctx.throw(400, 'Invalid API key scope');
    }
    await ctx.db
      .getRepository('msGraphGatewayApiKeys')
      .create({ values: { name: values.name ?? 'API key', keyHash: hashKey(plain), scopes } });
    ctx.body = { apiKey: plain, scopes };
  }

  private async authorize(ctx: RequestContext, required: Scope) {
    const key = String(ctx.request.headers['x-api-key'] ?? '');
    if (!key) ctx.throw(401, 'X-API-Key is required');
    const record = await ctx.db
      .getRepository('msGraphGatewayApiKeys')
      .findOne({ filter: { keyHash: hashKey(key), enabled: true } });
    const expiresAt = record?.get('expiresAt');
    const scopes = (record?.get('scopes') ?? []) as string[];
    if (!record || !scopes.includes(required)) ctx.throw(403, 'API key scope is not allowed');
    if (expiresAt && new Date(String(expiresAt)).getTime() <= Date.now()) ctx.throw(401, 'API key has expired');
    await record.update({ lastUsedAt: new Date() });
  }

  private async connection(ctx: RequestContext) {
    const record = await ctx.db.getRepository('msGraphGatewaySettings').findOne({ sort: ['-updatedAt'] });
    if (!record) ctx.throw(503, 'Microsoft Graph is not configured');
    const encryptedClientSecret = String(record.get('clientSecret') ?? '');
    if (!encryptedClientSecret) ctx.throw(503, 'Microsoft Graph client secret is not configured');
    const clientSecret = await this.app.aesEncryptor.decrypt(encryptedClientSecret);
    const fingerprint = hashKey(
      `${record.get('tenantId')}:${record.get('clientId')}:${record.get('updatedAt')}:${encryptedClientSecret}`,
    );
    let client = this.clients.get(fingerprint);
    if (!client) {
      client = createGraphClient({
        tenantId: record.get('tenantId'),
        clientId: record.get('clientId'),
        clientSecret,
      } as GraphSettings);
      this.clients.set(fingerprint, client);
    }
    return client;
  }

  async afterDisable() {
    this.clients.clear();
  }

  private async enqueue(ctx: RequestContext, operation: string, scope: Scope) {
    await this.authorize(ctx, scope);
    const values = payloadOf(ctx);
    const idempotencyKey = String(ctx.request.headers['idempotency-key'] ?? randomBytes(16).toString('hex'));
    const existing = await ctx.db.getRepository('msGraphGatewayQueue').findOne({ filter: { idempotencyKey } });
    if (existing) {
      ctx.body = { jobId: existing.get('jobId'), status: existing.get('status'), duplicate: true };
      return;
    }
    const job = await ctx.db
      .getRepository('msGraphGatewayQueue')
      .create({ values: { operation, payload: values, idempotencyKey, status: 'pending' } });
    ctx.body = { jobId: job.get('jobId'), status: 'pending', duplicate: false };
  }

  private async getJob(ctx: RequestContext) {
    await this.authorize(ctx, 'email:read');
    ctx.body = await ctx.db
      .getRepository('msGraphGatewayQueue')
      .findOne({ filter: { jobId: ctx.action.params.filterByTk ?? payloadOf(ctx).jobId } });
  }
  private async retryJob(ctx: RequestContext) {
    await this.authorize(ctx, 'email:write');
    const job = await ctx.db.getRepository('msGraphGatewayQueue').findOne({ filter: { jobId: payloadOf(ctx).jobId } });
    if (!job) ctx.throw(404, 'Job not found');
    await job.update({ status: 'pending', nextAttemptAt: null });
    ctx.body = { status: 'pending' };
  }

  private async listMessages(ctx: RequestContext) {
    await this.authorize(ctx, 'email:read');
    const values = payloadOf(ctx);
    const client = await this.connection(ctx);
    const request = client
      .api(
        `/users/${encodeURIComponent(String(values.user))}/mailFolders/${encodeURIComponent(
          String(values.folder ?? 'inbox'),
        )}/messages`,
      )
      .top(pageSizeOf(values.pageSize))
      .select(String(values.select ?? 'id,subject,from,receivedDateTime,hasAttachments'))
      .orderby('receivedDateTime DESC');
    if (values.filter) request.filter(String(values.filter));
    const result = await request.get();
    ctx.body = {
      data: result.value ?? [],
      nextCursor: result['@odata.nextLink'] ?? null,
      hasMore: Boolean(result['@odata.nextLink']),
    };
  }
  private async listItems(ctx: RequestContext) {
    await this.authorize(ctx, 'lists:read');
    const values = payloadOf(ctx);
    const result = await (await this.connection(ctx))
      .api(`/sites/${values.siteId}/lists/${values.listId}/items`)
      .expand('fields')
      .top(pageSizeOf(values.pageSize))
      .get();
    ctx.body = {
      data: result.value ?? [],
      nextCursor: result['@odata.nextLink'] ?? null,
      hasMore: Boolean(result['@odata.nextLink']),
    };
  }
  private async listDriveItems(ctx: RequestContext) {
    await this.authorize(ctx, 'drive:read');
    const values = payloadOf(ctx);
    const path = values.path ? `/root:/${String(values.path)}:/children` : '/root/children';
    const result = await (await this.connection(ctx))
      .api(`/drives/${values.driveId}${path}`)
      .top(pageSizeOf(values.pageSize))
      .get();
    ctx.body = {
      data: result.value ?? [],
      nextCursor: result['@odata.nextLink'] ?? null,
      hasMore: Boolean(result['@odata.nextLink']),
    };
  }
}

export default PluginMicrosoftGraphGatewayServer;
