import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Context, Next } from '@nocobase/actions';
import type { Model } from '@nocobase/database';
import { Plugin } from '@nocobase/server';
import type { Client, GraphRequest } from '@microsoft/microsoft-graph-client';
import { createGraphClient, GraphSettings } from './graph-client';

type Scope = 'email:read' | 'email:write' | 'lists:read' | 'lists:write' | 'drive:read' | 'drive:write';
type Values = Record<string, unknown>;
type GatewayApiKeyMetadata = { id: string; name: string; prefix: string };
type GatewayState = Context['state'] & {
  msGraphGatewayApiKey?: GatewayApiKeyMetadata;
  msGraphGatewayJob?: { jobId: string; idempotencyKey: string; duplicate?: boolean };
};
type GraphResult = Record<string, unknown> | unknown[] | null;
type JobOperation =
  | 'sendEmail'
  | 'replyEmail'
  | 'forwardEmail'
  | 'markEmail'
  | 'moveEmail'
  | 'deleteEmail'
  | 'createListItem'
  | 'updateListItem'
  | 'deleteListItem'
  | 'uploadFile'
  | 'createFolder'
  | 'moveDriveItem'
  | 'deleteDriveItem';

const MASK = '••••••••';
const ALL_SCOPES: Scope[] = ['email:read', 'email:write', 'lists:read', 'lists:write', 'drive:read', 'drive:write'];
const hashKey = (value: string) => createHash('sha256').update(value).digest('hex');
const payloadOf = (ctx: Context): Values => (ctx.action.params.values ?? ctx.request.body ?? {}) as Values;
const pageSizeOf = (value: unknown) => Math.min(Math.max(Number(value ?? 50) || 50, 1), 100);
export const graphCursorPath = (value: unknown, expectedPath: string) => {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 8192) throw new Error('Invalid pagination cursor');
  const cursor = new URL(raw, 'https://graph.microsoft.com');
  if (cursor.protocol !== 'https:' || cursor.hostname !== 'graph.microsoft.com' || cursor.port)
    throw new Error('Invalid pagination cursor');
  const expected = new URL(expectedPath, 'https://graph.microsoft.com');
  const cursorPath = cursor.pathname.replace(/^\/v1\.0(?=\/|$)/, '') || '/';
  if (cursorPath !== expected.pathname) throw new Error('Invalid pagination cursor');
  return `${cursorPath}${cursor.search}`;
};
export const hasRetryAuthentication = (ctx: Context) =>
  Boolean(ctx.request.headers['x-api-key'] || ctx.state.currentUser);
const stringOf = (value: unknown, name: string) => {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
};
const safeError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/mgk_[A-Za-z0-9_-]+/g, 'mgk_[REDACTED]')
    .replace(
      /(client[_ -]?secret|access[_ -]?token|api[_ -]?key|bearer|secret|password|token)\s*[:=]\s*\S+/gi,
      '$1=[REDACTED]',
    )
    .slice(0, 4000);
};
const graphRequestId = (error: unknown) => {
  if (!error || typeof error !== 'object') return null;
  const source = error as { requestId?: unknown; body?: { innerError?: { 'request-id'?: unknown } } };
  return String(source.requestId ?? source.body?.innerError?.['request-id'] ?? '') || null;
};
const errorMetadata = (error: unknown) => {
  if (!error || typeof error !== 'object') return { name: 'Error', code: null, gatewayStatus: 500, graphStatus: null };
  const source = error as { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown };
  const gatewayStatus = Number(source.status ?? source.statusCode ?? 500);
  const graphStatus = source.statusCode === undefined ? null : Number(source.statusCode);
  return {
    name: String(source.name ?? 'Error'),
    code: source.code === undefined ? null : String(source.code),
    gatewayStatus: Number.isFinite(gatewayStatus) ? gatewayStatus : 500,
    graphStatus: graphStatus !== null && Number.isFinite(graphStatus) ? graphStatus : null,
  };
};

export class PluginMicrosoftGraphGatewayServer extends Plugin {
  private clients = new Map<string, Client>();
  private timer: NodeJS.Timeout | null = null;
  private activeWorkers = 0;
  private readonly workerId = `${process.pid}-${randomBytes(4).toString('hex')}`;

  async beforeLoad() {
    this.db.on('msGraphGatewaySettings.beforeSave', async (model: Model) => {
      if (!model.changed('clientSecret')) return;
      const secret = String(model.get('clientSecret') ?? '');
      if (!secret || secret === MASK) return;
      model.set('clientSecret', await this.app.aesEncryptor.encrypt(secret));
    });
  }

  async load() {
    const action =
      (operation: string, handler: (ctx: Context) => Promise<void>) => async (ctx: Context, next: Next) => {
        const startedAt = new Date();
        const requestId = String(ctx.request.headers['x-request-id'] ?? randomUUID()).slice(0, 128);
        ctx.set('X-Request-ID', requestId);
        try {
          await handler(ctx);
        } catch (error) {
          const metadata = errorMetadata(error);
          const isValidationError =
            metadata.gatewayStatus === 500 && error instanceof Error && / is required$/.test(error.message);
          const gatewayStatus = isValidationError ? 400 : metadata.gatewayStatus;
          const isRejected = gatewayStatus >= 400 && gatewayStatus < 500;
          await this.auditRequestSafely(ctx, {
            requestId,
            operation,
            status: isRejected ? 'rejected' : 'failed',
            httpStatus: gatewayStatus,
            graphHttpStatus: metadata.graphStatus,
            graphRequestId: graphRequestId(error),
            error: safeError(error),
            errorCode: metadata.code,
            errorName: metadata.name,
            startedAt,
            finishedAt: new Date(),
            durationMs: Date.now() - startedAt.getTime(),
          });
          if (isValidationError && error instanceof Error) ctx.throw(400, error.message);
          throw error;
        }
        const job = (ctx.state as GatewayState).msGraphGatewayJob;
        const status = job ? 'queued' : 'succeeded';
        await this.auditRequestSafely(ctx, {
          requestId,
          jobId: job?.jobId ?? null,
          idempotencyKey: job?.idempotencyKey ?? null,
          operation,
          status,
          httpStatus: ctx.status || 200,
          graphHttpStatus: job ? null : 200,
          startedAt,
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt.getTime(),
        });
        await next();
      };
    this.app.resourceManager.define({
      name: 'msGraphGateway',
      actions: {
        getSettings: action('getSettings', (ctx) => this.getSettings(ctx)),
        saveSettings: action('saveSettings', (ctx) => this.saveSettings(ctx)),
        testConnection: action('testConnection', (ctx) => this.testConnection(ctx)),
        createApiKey: action('createApiKey', (ctx) => this.createApiKey(ctx)),
        listApiKeys: action('listApiKeys', (ctx) => this.listApiKeys(ctx)),
        revokeApiKey: action('revokeApiKey', (ctx) => this.revokeApiKey(ctx)),
        dashboard: action('dashboard', (ctx) => this.dashboard(ctx)),
        listJobs: action('listJobs', (ctx) => this.listJobs(ctx)),
        getJob: action('getJob', (ctx) => this.getJob(ctx)),
        retryJob: action('retryJob', (ctx) => this.retryJob(ctx)),
        listAuditLogs: action('listAuditLogs', (ctx) => this.listAuditLogs(ctx)),
        openapi: action('openapi', (ctx) => this.openapi(ctx)),
        sendEmail: action('sendEmail', (ctx) => this.enqueue(ctx, 'sendEmail', 'email:write')),
        replyEmail: action('replyEmail', (ctx) => this.enqueue(ctx, 'replyEmail', 'email:write')),
        forwardEmail: action('forwardEmail', (ctx) => this.enqueue(ctx, 'forwardEmail', 'email:write')),
        markEmail: action('markEmail', (ctx) => this.enqueue(ctx, 'markEmail', 'email:write')),
        moveEmail: action('moveEmail', (ctx) => this.enqueue(ctx, 'moveEmail', 'email:write')),
        deleteEmail: action('deleteEmail', (ctx) => this.enqueue(ctx, 'deleteEmail', 'email:write')),
        listMessages: action('listMessages', (ctx) => this.listMessages(ctx)),
        getMessage: action('getMessage', (ctx) => this.getMessage(ctx)),
        listAttachments: action('listAttachments', (ctx) => this.listAttachments(ctx)),
        getAttachment: action('getAttachment', (ctx) => this.getAttachment(ctx)),
        listSites: action('listSites', (ctx) => this.listSites(ctx)),
        listLists: action('listLists', (ctx) => this.listLists(ctx)),
        listColumns: action('listColumns', (ctx) => this.listColumns(ctx)),
        listItems: action('listItems', (ctx) => this.listItems(ctx)),
        getListItem: action('getListItem', (ctx) => this.getListItem(ctx)),
        createListItem: action('createListItem', (ctx) => this.enqueue(ctx, 'createListItem', 'lists:write')),
        updateListItem: action('updateListItem', (ctx) => this.enqueue(ctx, 'updateListItem', 'lists:write')),
        deleteListItem: action('deleteListItem', (ctx) => this.enqueue(ctx, 'deleteListItem', 'lists:write')),
        listDrives: action('listDrives', (ctx) => this.listDrives(ctx)),
        listDriveItems: action('listDriveItems', (ctx) => this.listDriveItems(ctx)),
        getDriveItem: action('getDriveItem', (ctx) => this.getDriveItem(ctx)),
        downloadFile: action('downloadFile', (ctx) => this.downloadFile(ctx)),
        createUploadSession: action('createUploadSession', (ctx) => this.createUploadSession(ctx)),
        uploadFile: action('uploadFile', (ctx) => this.enqueue(ctx, 'uploadFile', 'drive:write')),
        createFolder: action('createFolder', (ctx) => this.enqueue(ctx, 'createFolder', 'drive:write')),
        moveDriveItem: action('moveDriveItem', (ctx) => this.enqueue(ctx, 'moveDriveItem', 'drive:write')),
        deleteDriveItem: action('deleteDriveItem', (ctx) => this.enqueue(ctx, 'deleteDriveItem', 'drive:write')),
      },
    });

    const external = [
      'sendEmail',
      'replyEmail',
      'forwardEmail',
      'markEmail',
      'moveEmail',
      'deleteEmail',
      'listMessages',
      'getMessage',
      'listAttachments',
      'getAttachment',
      'listSites',
      'listLists',
      'listColumns',
      'listItems',
      'getListItem',
      'createListItem',
      'updateListItem',
      'deleteListItem',
      'listDrives',
      'listDriveItems',
      'getDriveItem',
      'downloadFile',
      'createUploadSession',
      'uploadFile',
      'createFolder',
      'moveDriveItem',
      'deleteDriveItem',
      'getJob',
      'retryJob',
    ];
    this.app.acl.allow('msGraphGateway', external, 'public');
    this.app.acl.allow(
      'msGraphGateway',
      [
        'getSettings',
        'saveSettings',
        'testConnection',
        'createApiKey',
        'listApiKeys',
        'revokeApiKey',
        'dashboard',
        'listJobs',
        'listAuditLogs',
        'openapi',
      ],
      'loggedIn',
    );
    this.app.acl.registerSnippet({ name: 'pm.microsoft-graph-gateway', actions: ['msGraphGateway:*'] });

    this.app.on('afterStart', async () => this.startWorker());
  }

  async afterDisable() {
    this.stopWorker();
  }
  async beforeUnload() {
    this.stopWorker();
  }

  private startWorker() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.log.error('Microsoft Graph queue tick failed', { error: safeError(error) }));
    }, 2000);
    this.tick().catch((error) =>
      this.log.error('Microsoft Graph initial queue tick failed', { error: safeError(error) }),
    );
  }

  private stopWorker() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.clients.clear();
  }

  private async settingsRecord() {
    return this.db.getRepository('msGraphGatewaySettings').findOne({ sort: ['-updatedAt'] });
  }

  private async getSettings(ctx: Context) {
    const record = await this.settingsRecord();
    if (!record) {
      ctx.body = { data: null };
      return;
    }
    const data = record.toJSON() as Values;
    data.clientSecret = data.clientSecret ? MASK : '';
    ctx.body = { data };
  }

  private async saveSettings(ctx: Context) {
    const values = payloadOf(ctx);
    const existing = await this.settingsRecord();
    const update: Values = {
      name: String(values.name ?? 'default'),
      tenantId: stringOf(values.tenantId, 'tenantId'),
      clientId: stringOf(values.clientId, 'clientId'),
      maxAttempts: Math.max(1, Number(values.maxAttempts ?? 5)),
      concurrency: Math.max(1, Number(values.concurrency ?? 2)),
      batchSize: Math.max(1, Number(values.batchSize ?? 10)),
      retryBaseSeconds: Math.max(1, Number(values.retryBaseSeconds ?? 30)),
      processingTimeoutMinutes: Math.max(1, Number(values.processingTimeoutMinutes ?? 15)),
    };
    if (values.clientSecret && values.clientSecret !== MASK) update.clientSecret = String(values.clientSecret);
    if (!existing && !update.clientSecret) ctx.throw(400, 'clientSecret is required');
    const record = existing
      ? await existing.update(update)
      : await ctx.db.getRepository('msGraphGatewaySettings').create({ values: update });
    this.clients.clear();
    const data = record.toJSON() as Values;
    data.clientSecret = MASK;
    ctx.body = { data };
  }

  private async connection() {
    const record = await this.settingsRecord();
    if (!record) throw new Error('Microsoft Graph is not configured');
    const encrypted = String(record.get('clientSecret') ?? '');
    if (!encrypted) throw new Error('Microsoft Graph client secret is not configured');
    const fingerprint = hashKey(
      `${record.get('tenantId')}:${record.get('clientId')}:${record.get('updatedAt')}:${encrypted}`,
    );
    let client = this.clients.get(fingerprint);
    if (!client) {
      const clientSecret = await this.app.aesEncryptor.decrypt(encrypted);
      client = createGraphClient({
        tenantId: String(record.get('tenantId')),
        clientId: String(record.get('clientId')),
        clientSecret,
      } as GraphSettings);
      this.clients.clear();
      this.clients.set(fingerprint, client);
    }
    return client;
  }

  private async testConnection(ctx: Context) {
    const started = Date.now();
    try {
      const result = await (await this.connection()).api('/organization').select('id,displayName').top(1).get();
      ctx.body = { success: true, organization: result.value?.[0] ?? null, durationMs: Date.now() - started };
    } catch (error) {
      ctx.throw(502, `Microsoft Graph connection failed: ${safeError(error)}`);
    }
  }

  private async createApiKey(ctx: Context) {
    const values = payloadOf(ctx);
    const scopes = Array.isArray(values.scopes)
      ? values.scopes
      : ['email:read', 'email:write', 'lists:read', 'drive:read'];
    if (!scopes.every((scope): scope is Scope => typeof scope === 'string' && ALL_SCOPES.includes(scope as Scope)))
      ctx.throw(400, 'Invalid API key scope');
    const plain = `mgk_${randomBytes(32).toString('base64url')}`;
    const record = await ctx.db.getRepository('msGraphGatewayApiKeys').create({
      values: {
        name: String(values.name ?? 'API key'),
        keyHash: hashKey(plain),
        keyPrefix: plain.slice(0, 12),
        scopes,
        expiresAt: values.expiresAt ?? null,
        enabled: true,
      },
    });
    ctx.body = { data: { ...record.toJSON(), keyHash: undefined, apiKey: plain } };
  }

  private async listApiKeys(ctx: Context) {
    const rows = await ctx.db.getRepository('msGraphGatewayApiKeys').find({ sort: ['-createdAt'] });
    ctx.body = {
      data: rows.map((row) => {
        const item = row.toJSON() as Values;
        delete item.keyHash;
        return item;
      }),
    };
  }

  private async revokeApiKey(ctx: Context) {
    const id = payloadOf(ctx).id ?? ctx.action.params.filterByTk;
    const record = await ctx.db.getRepository('msGraphGatewayApiKeys').findOne({ filterByTk: id });
    if (!record) ctx.throw(404, 'API key not found');
    await record.update({ enabled: false, revokedAt: new Date() });
    ctx.body = { success: true };
  }

  private async authenticate(ctx: Context) {
    const key = String(ctx.request.headers['x-api-key'] ?? '');
    if (!key) ctx.throw(401, 'X-API-Key is required');
    const record = await ctx.db
      .getRepository('msGraphGatewayApiKeys')
      .findOne({ filter: { keyHash: hashKey(key), enabled: true } });
    if (!record) ctx.throw(401, 'Invalid API key');
    const expiresAt = record.get('expiresAt');
    if (expiresAt && new Date(String(expiresAt)).getTime() <= Date.now()) ctx.throw(401, 'API key has expired');
    await record.update({ lastUsedAt: new Date() });
    (ctx.state as GatewayState).msGraphGatewayApiKey = {
      id: String(record.get('id')),
      name: String(record.get('name') ?? ''),
      prefix: String(record.get('keyPrefix') ?? ''),
    };
    return record;
  }

  private async authorize(ctx: Context, required: Scope) {
    const record = await this.authenticate(ctx);
    const scopes = (record.get('scopes') ?? []) as string[];
    if (!scopes.includes(required)) ctx.throw(403, `API key scope ${required} is required`);
  }

  private async enqueue(ctx: Context, operation: JobOperation, scope: Scope) {
    await this.authorize(ctx, scope);
    const values = payloadOf(ctx);
    const idempotencyKey = String(ctx.request.headers['idempotency-key'] ?? randomUUID());
    const existing = await ctx.db.getRepository('msGraphGatewayQueue').findOne({ filter: { idempotencyKey } });
    if (existing) {
      (ctx.state as GatewayState).msGraphGatewayJob = {
        jobId: String(existing.get('jobId')),
        idempotencyKey,
        duplicate: true,
      };
      ctx.body = { data: { jobId: existing.get('jobId'), status: existing.get('status'), duplicate: true } };
      return;
    }
    const job = await ctx.db
      .getRepository('msGraphGatewayQueue')
      .create({ values: { operation, payload: values, idempotencyKey, status: 'pending', attempts: 0 } });
    (ctx.state as GatewayState).msGraphGatewayJob = {
      jobId: String(job.get('jobId')),
      idempotencyKey,
      duplicate: false,
    };
    ctx.body = { data: { jobId: job.get('jobId'), status: 'pending', duplicate: false } };
  }

  private async tick() {
    const settings = await this.settingsRecord();
    if (!settings) return;
    const concurrency = Math.max(1, Number(settings.get('concurrency') ?? 2));
    if (this.activeWorkers >= concurrency) return;
    const timeoutMinutes = Math.max(1, Number(settings.get('processingTimeoutMinutes') ?? 15));
    await this.db.getRepository('msGraphGatewayQueue').update({
      filter: { status: 'processing', startedAt: { $lt: new Date(Date.now() - timeoutMinutes * 60000) } },
      values: { status: 'retrying', nextAttemptAt: new Date(), lockedBy: null },
    });
    const limit = Math.min(Number(settings.get('batchSize') ?? 10), concurrency - this.activeWorkers);
    const jobs = await this.db.getRepository('msGraphGatewayQueue').find({
      filter: { $or: [{ status: 'pending' }, { status: 'retrying', nextAttemptAt: { $lte: new Date() } }] },
      sort: ['createdAt'],
      limit,
    });
    await Promise.all(
      jobs.map(async (job) => {
        const status = String(job.get('status'));
        const attempt = Number(job.get('attempts') ?? 0) + 1;
        const startedAt = new Date();
        const claimFilter =
          status === 'retrying'
            ? { id: job.get('id'), status, nextAttemptAt: { $lte: startedAt } }
            : { id: job.get('id'), status: 'pending' };
        const [affected] = await this.db.getRepository('msGraphGatewayQueue').update({
          filter: claimFilter,
          values: {
            status: 'processing',
            attempts: attempt,
            startedAt,
            lockedBy: this.workerId,
            lastError: null,
          },
        });
        if (affected <= 0) return;
        this.activeWorkers += 1;
        try {
          await this.processJob(job, settings, attempt, startedAt.getTime());
        } catch (error) {
          this.log.error('Microsoft Graph job processing failed unexpectedly', { error: safeError(error) });
        } finally {
          this.activeWorkers -= 1;
        }
      }),
    );
  }

  private async processJob(job: Model, settings: Model, attempt: number, started: number) {
    const operation = String(job.get('operation')) as JobOperation;
    try {
      await this.execute(operation, (job.get('payload') ?? {}) as Values);
      await job.update({ status: 'succeeded', result: null, finishedAt: new Date(), lockedBy: null });
      await this.audit({
        jobId: String(job.get('jobId')),
        idempotencyKey: String(job.get('idempotencyKey') ?? '') || null,
        operation,
        status: 'succeeded',
        httpStatus: 200,
        graphHttpStatus: 200,
        attempt,
        durationMs: Date.now() - started,
        startedAt: new Date(started),
        finishedAt: new Date(),
      });
    } catch (error) {
      const maxAttempts = Math.max(1, Number(settings.get('maxAttempts') ?? 5));
      const failed = attempt >= maxAttempts;
      const delay = Math.max(1, Number(settings.get('retryBaseSeconds') ?? 30)) * 2 ** Math.max(0, attempt - 1);
      const requestId = graphRequestId(error);
      const meta = errorMetadata(error);
      await job.update({
        status: failed ? 'failed' : 'retrying',
        lastError: safeError(error),
        graphRequestId: requestId,
        nextAttemptAt: failed ? null : new Date(Date.now() + delay * 1000),
        finishedAt: failed ? new Date() : null,
        lockedBy: null,
      });
      await this.audit({
        jobId: String(job.get('jobId')),
        idempotencyKey: String(job.get('idempotencyKey') ?? '') || null,
        operation,
        status: failed ? 'failed' : 'retrying',
        httpStatus: 502,
        graphHttpStatus: meta.graphStatus,
        graphRequestId: requestId,
        attempt,
        durationMs: Date.now() - started,
        error: safeError(error),
        errorCode: meta.code,
        errorName: meta.name,
        startedAt: new Date(started),
        finishedAt: new Date(),
      });
    }
  }

  private async execute(operation: JobOperation, values: Values): Promise<GraphResult> {
    const client = await this.connection();
    if (operation.endsWith('Email')) {
      const user = encodeURIComponent(stringOf(values.user, 'user'));
      if (operation === 'sendEmail')
        return client
          .api(`/users/${user}/sendMail`)
          .post({ message: values.message, saveToSentItems: values.saveToSentItems !== false });
      if (operation === 'replyEmail')
        return client
          .api(`/users/${user}/messages/${stringOf(values.messageId, 'messageId')}/reply`)
          .post({ comment: values.comment ?? '', message: values.message });
      if (operation === 'forwardEmail')
        return client
          .api(`/users/${user}/messages/${stringOf(values.messageId, 'messageId')}/forward`)
          .post({ comment: values.comment ?? '', toRecipients: values.toRecipients });
      if (operation === 'markEmail')
        return client
          .api(`/users/${user}/messages/${stringOf(values.messageId, 'messageId')}`)
          .patch({ isRead: Boolean(values.isRead) });
      if (operation === 'moveEmail')
        return client
          .api(`/users/${user}/messages/${stringOf(values.messageId, 'messageId')}/move`)
          .post({ destinationId: stringOf(values.destinationId, 'destinationId') });
      if (operation === 'deleteEmail')
        return client.api(`/users/${user}/messages/${stringOf(values.messageId, 'messageId')}`).delete();
    }
    const siteId = stringOf(values.siteId, 'siteId');
    const listId = stringOf(values.listId, 'listId');
    if (operation === 'createListItem')
      return client.api(`/sites/${siteId}/lists/${listId}/items`).post({ fields: values.fields });
    if (operation === 'updateListItem')
      return client
        .api(`/sites/${siteId}/lists/${listId}/items/${stringOf(values.itemId, 'itemId')}/fields`)
        .patch(values.fields);
    if (operation === 'deleteListItem')
      return client.api(`/sites/${siteId}/lists/${listId}/items/${stringOf(values.itemId, 'itemId')}`).delete();
    const driveId = stringOf(values.driveId, 'driveId');
    if (operation === 'uploadFile') {
      const content = Buffer.from(stringOf(values.contentBase64, 'contentBase64'), 'base64');
      if (content.length > 4 * 1024 * 1024) throw new Error('Files larger than 4 MB must use createUploadSession');
      return client.api(`/drives/${driveId}/root:/${stringOf(values.path, 'path')}:/content`).put(content);
    }
    if (operation === 'createFolder')
      return client.api(`/drives/${driveId}/items/${String(values.parentItemId ?? 'root')}/children`).post({
        name: stringOf(values.name, 'name'),
        folder: {},
        '@microsoft.graph.conflictBehavior': values.conflictBehavior ?? 'rename',
      });
    if (operation === 'moveDriveItem')
      return client
        .api(`/drives/${driveId}/items/${stringOf(values.itemId, 'itemId')}`)
        .patch({ name: values.name, parentReference: values.parentItemId ? { id: values.parentItemId } : undefined });
    if (operation === 'deleteDriveItem')
      return client.api(`/drives/${driveId}/items/${stringOf(values.itemId, 'itemId')}`).delete();
    throw new Error(`Unsupported operation: ${operation}`);
  }

  private async graphList(ctx: Context, scope: Scope, path: string, values: Values, expand?: string) {
    await this.authorize(ctx, scope);
    const client = await this.connection();
    let request: GraphRequest;
    try {
      request = values.cursor
        ? client.api(graphCursorPath(values.cursor, path))
        : client.api(path).top(pageSizeOf(values.pageSize));
    } catch (error) {
      if (error instanceof Error && error.message === 'Invalid pagination cursor') ctx.throw(400, error.message);
      throw error;
    }
    if (!values.cursor) {
      if (values.select) request = request.select(String(values.select));
      if (values.filter) request = request.filter(String(values.filter));
      if (values.orderBy) request = request.orderby(String(values.orderBy));
      if (expand) request = request.expand(expand);
    }
    const result = await request.get();
    ctx.body = {
      data: result.value ?? [],
      nextCursor: result['@odata.nextLink'] ?? null,
      hasMore: Boolean(result['@odata.nextLink']),
    };
  }

  private async graphGet(ctx: Context, scope: Scope, path: string) {
    await this.authorize(ctx, scope);
    ctx.body = { data: await (await this.connection()).api(path).get() };
  }

  private listMessages(ctx: Context) {
    const v = payloadOf(ctx);
    return this.graphList(
      ctx,
      'email:read',
      `/users/${encodeURIComponent(stringOf(v.user, 'user'))}/mailFolders/${encodeURIComponent(
        String(v.folder ?? 'inbox'),
      )}/messages`,
      { orderBy: 'receivedDateTime DESC', ...v },
    );
  }
  private getMessage(ctx: Context) {
    const v = payloadOf(ctx);
    return this.graphGet(
      ctx,
      'email:read',
      `/users/${encodeURIComponent(stringOf(v.user, 'user'))}/messages/${stringOf(v.messageId, 'messageId')}`,
    );
  }
  private listAttachments(ctx: Context) {
    const v = payloadOf(ctx);
    return this.graphList(
      ctx,
      'email:read',
      `/users/${encodeURIComponent(stringOf(v.user, 'user'))}/messages/${stringOf(
        v.messageId,
        'messageId',
      )}/attachments`,
      v,
    );
  }
  private getAttachment(ctx: Context) {
    const v = payloadOf(ctx);
    return this.graphGet(
      ctx,
      'email:read',
      `/users/${encodeURIComponent(stringOf(v.user, 'user'))}/messages/${stringOf(
        v.messageId,
        'messageId',
      )}/attachments/${stringOf(v.attachmentId, 'attachmentId')}`,
    );
  }
  private listSites(ctx: Context) {
    const v = payloadOf(ctx);
    const path = v.search ? `/sites?search=${encodeURIComponent(String(v.search))}` : '/sites/root/sites';
    return this.graphList(ctx, 'lists:read', path, v);
  }
  private listLists(ctx: Context) {
    const v = payloadOf(ctx);
    return this.graphList(ctx, 'lists:read', `/sites/${stringOf(v.siteId, 'siteId')}/lists`, v);
  }
  private listColumns(ctx: Context) {
    const v = payloadOf(ctx);
    return this.graphList(
      ctx,
      'lists:read',
      `/sites/${stringOf(v.siteId, 'siteId')}/lists/${stringOf(v.listId, 'listId')}/columns`,
      v,
    );
  }
  private listItems(ctx: Context) {
    const v = payloadOf(ctx);
    return this.graphList(
      ctx,
      'lists:read',
      `/sites/${stringOf(v.siteId, 'siteId')}/lists/${stringOf(v.listId, 'listId')}/items`,
      v,
      'fields',
    );
  }
  private getListItem(ctx: Context) {
    const v = payloadOf(ctx);
    return this.graphGet(
      ctx,
      'lists:read',
      `/sites/${stringOf(v.siteId, 'siteId')}/lists/${stringOf(v.listId, 'listId')}/items/${stringOf(
        v.itemId,
        'itemId',
      )}?expand=fields`,
    );
  }
  private listDrives(ctx: Context) {
    const v = payloadOf(ctx);
    return this.graphList(ctx, 'drive:read', `/sites/${stringOf(v.siteId, 'siteId')}/drives`, v);
  }
  private listDriveItems(ctx: Context) {
    const v = payloadOf(ctx);
    const suffix = v.itemId
      ? `/items/${v.itemId}/children`
      : v.path
        ? `/root:/${String(v.path)}:/children`
        : '/root/children';
    return this.graphList(ctx, 'drive:read', `/drives/${stringOf(v.driveId, 'driveId')}${suffix}`, v);
  }
  private getDriveItem(ctx: Context) {
    const v = payloadOf(ctx);
    const suffix = v.itemId ? `/items/${v.itemId}` : `/root:/${stringOf(v.path, 'path')}`;
    return this.graphGet(ctx, 'drive:read', `/drives/${stringOf(v.driveId, 'driveId')}${suffix}`);
  }

  private async downloadFile(ctx: Context) {
    const v = payloadOf(ctx);
    await this.authorize(ctx, 'drive:read');
    const metadata = await (await this.connection())
      .api(`/drives/${stringOf(v.driveId, 'driveId')}/items/${stringOf(v.itemId, 'itemId')}`)
      .get();
    ctx.body = {
      data: { name: metadata.name, size: metadata.size, downloadUrl: metadata['@microsoft.graph.downloadUrl'] },
    };
  }

  private async createUploadSession(ctx: Context) {
    const v = payloadOf(ctx);
    await this.authorize(ctx, 'drive:write');
    const result = await (await this.connection())
      .api(`/drives/${stringOf(v.driveId, 'driveId')}/root:/${stringOf(v.path, 'path')}:/createUploadSession`)
      .post({
        item: {
          '@microsoft.graph.conflictBehavior': v.conflictBehavior ?? 'rename',
          name: String(v.name ?? String(v.path).split('/').pop()),
        },
      });
    ctx.body = { data: result };
  }

  private async getJob(ctx: Context) {
    await this.authenticate(ctx);
    const v = payloadOf(ctx);
    const jobId = v.jobId ?? ctx.action.params.filterByTk;
    ctx.body = { data: await ctx.db.getRepository('msGraphGatewayQueue').findOne({ filter: { jobId } }) };
  }

  private async retryJob(ctx: Context) {
    const hasExternalKey = Boolean(ctx.request.headers['x-api-key']);
    if (!hasRetryAuthentication(ctx)) ctx.throw(401, 'Authentication is required');
    const v = payloadOf(ctx);
    const job = await ctx.db.getRepository('msGraphGatewayQueue').findOne({ filter: { jobId: v.jobId } });
    if (!job) ctx.throw(404, 'Job not found');
    if (hasExternalKey) {
      const operation = String(job.get('operation'));
      const scope: Scope = operation.includes('List')
        ? 'lists:write'
        : operation.includes('Drive') || operation === 'uploadFile' || operation === 'createFolder'
          ? 'drive:write'
          : 'email:write';
      await this.authorize(ctx, scope);
    }
    await job.update({
      status: 'pending',
      result: null,
      nextAttemptAt: null,
      finishedAt: null,
      lastError: null,
      lockedBy: null,
    });
    await this.audit({
      jobId: String(job.get('jobId')),
      operation: String(job.get('operation')),
      status: 'manual_retry',
    });
    ctx.body = { data: { jobId: job.get('jobId'), status: 'pending' } };
  }

  private async listJobs(ctx: Context) {
    const v = payloadOf(ctx);
    const page = Math.max(1, Number(v.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(v.pageSize ?? 20)));
    const filter: Record<string, unknown> = {};
    if (v.status) filter.status = v.status;
    if (v.operation) filter.operation = v.operation;
    const [rows, count] = await Promise.all([
      ctx.db
        .getRepository('msGraphGatewayQueue')
        .find({ filter, sort: ['-createdAt'], offset: (page - 1) * pageSize, limit: pageSize }),
      ctx.db.getRepository('msGraphGatewayQueue').count({ filter }),
    ]);
    ctx.body = { data: rows, meta: { page, pageSize, count, totalPage: Math.ceil(count / pageSize) } };
  }

  private async listAuditLogs(ctx: Context) {
    const v = payloadOf(ctx);
    const page = Math.max(1, Number(v.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(v.pageSize ?? 20)));
    const filter: Record<string, unknown> = {};
    if (v.status) filter.status = v.status;
    if (v.operation) filter.operation = v.operation;
    if (v.httpStatus) filter.httpStatus = Number(v.httpStatus);
    const [rows, count] = await Promise.all([
      ctx.db
        .getRepository('msGraphGatewayAuditLogs')
        .find({ filter, sort: ['-createdAt'], offset: (page - 1) * pageSize, limit: pageSize }),
      ctx.db.getRepository('msGraphGatewayAuditLogs').count({ filter }),
    ]);
    ctx.body = { data: rows, meta: { page, pageSize, count, totalPage: Math.ceil(count / pageSize) } };
  }

  private async dashboard(ctx: Context) {
    const statuses = ['pending', 'processing', 'retrying', 'succeeded', 'failed'];
    const pairs = await Promise.all(
      statuses.map(async (status) => [
        status,
        await ctx.db.getRepository('msGraphGatewayQueue').count({ filter: { status } }),
      ]),
    );
    ctx.body = { data: Object.fromEntries(pairs) };
  }

  private async audit(values: Values) {
    await this.db.getRepository('msGraphGatewayAuditLogs').create({ values: { requestId: randomUUID(), ...values } });
  }

  private async auditRequestSafely(ctx: Context, values: Values) {
    const body = payloadOf(ctx);
    const apiKey = (ctx.state as GatewayState).msGraphGatewayApiKey;
    const rawApiKey = String(ctx.request.headers['x-api-key'] ?? '');
    const fallbackPrefix = rawApiKey ? rawApiKey.slice(0, 12) : null;
    let requestSize: number | null = null;
    try {
      requestSize = Buffer.byteLength(JSON.stringify(body));
    } catch {
      requestSize = null;
    }
    try {
      await this.audit({
        route: String(ctx.request.path ?? ctx.request.url ?? ''),
        method: String(ctx.request.method ?? 'POST').toUpperCase(),
        apiKeyId: apiKey?.id ?? null,
        apiKeyName: apiKey?.name ?? null,
        apiKeyPrefix: apiKey?.prefix ?? fallbackPrefix,
        clientIp: String(ctx.ip ?? ''),
        userAgent: String(ctx.request.headers['user-agent'] ?? '').slice(0, 1000),
        requestSize,
        requestFields: Object.keys(body).sort(),
        ...values,
      });
    } catch (error) {
      this.log.error('Microsoft Graph request audit failed', { error: safeError(error) });
    }
  }

  private openapi(ctx: Context) {
    const actions = [
      'sendEmail',
      'replyEmail',
      'forwardEmail',
      'markEmail',
      'moveEmail',
      'deleteEmail',
      'listMessages',
      'getMessage',
      'listAttachments',
      'getAttachment',
      'listSites',
      'listLists',
      'listColumns',
      'listItems',
      'getListItem',
      'createListItem',
      'updateListItem',
      'deleteListItem',
      'listDrives',
      'listDriveItems',
      'getDriveItem',
      'downloadFile',
      'createUploadSession',
      'uploadFile',
      'createFolder',
      'moveDriveItem',
      'deleteDriveItem',
      'getJob',
      'retryJob',
    ];
    const paths = Object.fromEntries(
      actions.map((name) => [
        `/api/msGraphGateway:${name}`,
        {
          post: {
            summary: name,
            security: [{ ApiKeyAuth: [] }],
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
            },
            responses: {
              '200': { description: 'Successful response' },
              '4XX': { description: 'Invalid request or API key' },
              '5XX': { description: 'Microsoft Graph or gateway error' },
            },
          },
        },
      ]),
    );
    ctx.body = {
      openapi: '3.0.3',
      info: { title: 'Microsoft Graph Gateway API', version: '1.1.0' },
      servers: [{ url: '/' }],
      components: { securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } },
      paths,
    };
  }
}

export default PluginMicrosoftGraphGatewayServer;
