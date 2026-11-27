// SPDX-License-Identifier: Apache-2.0

import * as crypto from 'crypto';
import type { Context, Next } from '@nocobase/actions';
import { koaMulter } from '@nocobase/utils';
import { createProblem, type SubmissionPayload } from '../contracts/du-contracts';
import type { DocumentUnderstandingService } from '../services/DocumentUnderstandingService';
import { DuHttpError } from '../services/ArtifactStorageService';
import type { ApiKeyAuthPrincipal } from '../services/OperationOrchestrator';

type DataWrappingContext = Context & { withoutDataWrapping?: boolean; disableBodyParser?: boolean };

const DU_NAMESPACE_PREFIX = '/api/du/v1';
const CANONICAL_ROOT_PATTERN = /^\/api\/v1\/(health|uploads|businesses|operations|artifacts|usage|docs)(\/.*)?$/;

const legacyMultipartUpload = koaMulter({
  storage: koaMulter.memoryStorage(),
  limits: { files: 20, fileSize: 64 * 1024 * 1024, fields: 30, fieldSize: 2 * 1024 * 1024 },
}).any();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function matchDuGatewayPath(pathname: string): { matched: boolean; subPath: string; urlPrefix: string } {
  if (pathname === DU_NAMESPACE_PREFIX || pathname.startsWith(`${DU_NAMESPACE_PREFIX}/`)) {
    return {
      matched: true,
      subPath: pathname.slice(DU_NAMESPACE_PREFIX.length) || '/',
      urlPrefix: DU_NAMESPACE_PREFIX,
    };
  }
  if (CANONICAL_ROOT_PATTERN.test(pathname)) {
    return {
      matched: true,
      subPath: pathname.slice('/api/v1'.length) || '/',
      urlPrefix: '/api/v1',
    };
  }
  return { matched: false, subPath: '', urlPrefix: DU_NAMESPACE_PREFIX };
}

async function readStreamBuffer(ctx: Context, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of ctx.req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new DuHttpError(createProblem(413, 'PAYLOAD_TOO_LARGE', `Request body exceeds ${maxBytes} bytes`));
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(ctx: Context, maxBytes = 2 * 1024 * 1024): Promise<Record<string, unknown>> {
  if (isRecord(ctx.request.body)) {
    return ctx.request.body;
  }
  const raw = await readStreamBuffer(ctx, maxBytes);
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (!isRecord(parsed)) {
      throw new Error('Root JSON value must be an object');
    }
    return parsed;
  } catch (err) {
    throw new DuHttpError(
      createProblem(400, 'INVALID_JSON', err instanceof Error ? err.message : 'Malformed JSON body'),
    );
  }
}

async function resolveGatewayPrincipal(
  ctx: Context,
  service: DocumentUnderstandingService,
): Promise<ApiKeyAuthPrincipal> {
  const rawApiKey = ctx.get('x-api-key');
  if (rawApiKey) {
    return service.orchestrator.authenticateRawApiKey(rawApiKey);
  }

  // Also support NocoBase session / Bearer JWT API keys (matching plugin-ai-api conventions)
  if (ctx.state?.currentUser?.id) {
    return {
      kind: 'nocobase_user',
      tenantId: ctx.get('x-tenant-id')?.trim() || 'default',
      userId: Number(ctx.state.currentUser.id),
      allowedBusinesses: ['*'],
      allowedActions: ['*'],
    };
  }

  const authHeader = ctx.get('Authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.startsWith('du_live_')) {
      return service.orchestrator.authenticateRawApiKey(token);
    }
    const jwt = (
      ctx.app as unknown as { authManager?: { jwt?: { decode: (t: string) => Promise<{ userId?: number }> } } }
    ).authManager?.jwt;
    if (jwt && token) {
      try {
        const decoded = await jwt.decode(token);
        if (decoded?.userId) {
          const user = await ctx.db.getRepository('users').findOne({ filterByTk: decoded.userId });
          if (user) {
            return {
              kind: 'nocobase_user',
              tenantId: ctx.get('x-tenant-id')?.trim() || 'default',
              userId: Number(user.id),
              allowedBusinesses: ['*'],
              allowedActions: ['*'],
            };
          }
        }
      } catch {
        // Fall through to 401
      }
    }
  }

  throw new DuHttpError(
    createProblem(401, 'UNAUTHENTICATED', 'Missing or invalid x-api-key or Authorization Bearer credentials'),
  );
}

export function createDuDisableBodyParserMiddleware() {
  return async (ctx: Context, next: Next) => {
    const matched = matchDuGatewayPath(ctx.path);
    if (matched.matched) {
      if (
        (ctx.method === 'PUT' && /^\/uploads\/[^/]+\/content$/.test(matched.subPath)) ||
        (ctx.method === 'POST' && matched.subPath.startsWith('/docs/'))
      ) {
        (ctx as DataWrappingContext).disableBodyParser = true;
      }
    }
    await next();
  };
}

export function createDuGatewayRouter(getService: () => DocumentUnderstandingService) {
  return async (ctx: Context, next: Next) => {
    const routeMatch = matchDuGatewayPath(ctx.path);
    if (!routeMatch.matched) {
      return next();
    }

    (ctx as DataWrappingContext).withoutDataWrapping = true;
    const { subPath, urlPrefix } = routeMatch;
    const method = ctx.method.toUpperCase();
    const correlationId = (ctx.get('x-correlation-id') || crypto.randomUUID()).trim();
    ctx.set('x-correlation-id', correlationId);

    const service = getService();
    await service.ensureInitialized();
    const config = await service.getConfig();

    if (config.publicGatewayEnabled === false) {
      ctx.status = 503;
      ctx.type = 'application/problem+json';
      ctx.body = createProblem(503, 'TEMPORARY_UNAVAILABLE', 'Document Understanding Public Gateway is disabled', {
        correlationId,
      });
      return;
    }

    try {
      // 1. Health endpoint (`GET /health`)
      if (method === 'GET' && subPath === '/health') {
        ctx.status = 200;
        ctx.body = await service.getGatewayHealth();
        return;
      }

      // Authenticate all non-health endpoints (Fail-Closed before reading large payloads)
      const principal = await resolveGatewayPrincipal(ctx, service);

      // 2. Upload Gateway (`POST /uploads`, `PUT /uploads/:id/content`, `POST /uploads/:id/complete|abort`)
      if (method === 'POST' && subPath === '/uploads') {
        const body = await readJsonBody(ctx);
        const res = await service.orchestrator.artifactStorage.initiateUpload({
          tenantId: principal.tenantId,
          fileName: String(body.fileName || ''),
          mimeType: typeof body.mimeType === 'string' ? body.mimeType : undefined,
          sizeBytes: Number(body.sizeBytes ?? 0),
          uploadToken: typeof body.uploadToken === 'string' ? body.uploadToken : undefined,
          idempotencyKey: ctx.get('Idempotency-Key') || undefined,
          userId: principal.userId,
          urlPrefix,
        });
        ctx.status = res.httpStatus;
        ctx.body = {
          artifactId: res.artifactId,
          state: res.state,
          replayed: res.replayed,
          uploadUrl: res.uploadUrl,
        };
        return;
      }

      const uploadContentMatch = /^\/uploads\/([^/]+)\/content$/.exec(subPath);
      if (method === 'PUT' && uploadContentMatch) {
        const artifactId = decodeURIComponent(uploadContentMatch[1]);
        const rawBytes = Buffer.isBuffer(ctx.request.body)
          ? ctx.request.body
          : await readStreamBuffer(ctx, 64 * 1024 * 1024);
        const res = await service.orchestrator.artifactStorage.writeUploadContent({
          tenantId: principal.tenantId,
          artifactId,
          buffer: rawBytes,
          expectedSha256: ctx.get('x-content-sha256') || undefined,
        });
        ctx.status = res.httpStatus;
        ctx.body = {
          artifactId: res.artifactId,
          state: res.state,
          sizeBytes: res.sizeBytes,
          replayed: res.replayed,
        };
        return;
      }

      const uploadLifecycleMatch = /^\/uploads\/([^/]+)\/(complete|abort|part)$/.exec(subPath);
      if (method === 'POST' && uploadLifecycleMatch) {
        const artifactId = decodeURIComponent(uploadLifecycleMatch[1]);
        const subAction = uploadLifecycleMatch[2];
        if (subAction === 'part') {
          throw new DuHttpError(
            createProblem(
              501,
              'NOT_IMPLEMENTED',
              'Direct S3 multipart part URLs are disabled when gateway upload is active',
            ),
          );
        }
        ctx.status = 200;
        ctx.body =
          subAction === 'complete'
            ? await service.orchestrator.artifactStorage.completeUpload(principal.tenantId, artifactId)
            : await service.orchestrator.artifactStorage.abortUpload(principal.tenantId, artifactId);
        return;
      }

      // 3. Canonical Action Submission (`POST /businesses/:businessId/actions/:action`)
      const bizActionMatch = /^\/businesses\/([^/]+)\/actions\/([^/]+)$/.exec(subPath);
      if (method === 'POST' && bizActionMatch) {
        const businessId = decodeURIComponent(bizActionMatch[1]);
        const action = decodeURIComponent(bizActionMatch[2]);
        const body = (await readJsonBody(ctx)) as unknown as SubmissionPayload;
        const syncRequested = ctx.query.sync === 'true';
        const res = await service.orchestrator.submitOperation({
          principal,
          businessId,
          action,
          submission: body,
          idempotencyKey: ctx.get('Idempotency-Key') || undefined,
          correlationId,
          urlPrefix,
          waitCompletionMs: syncRequested ? Math.min(config.pollTimeout || 30_000, 30_000) : 0,
        });
        ctx.status = res.httpStatus;
        ctx.body = {
          operationId: res.operationId,
          state: res.state,
          stateVersion: res.stateVersion,
          replayed: res.replayed,
          correlationId: res.correlationId,
          links: res.links,
        };
        return;
      }

      // 4. Operations List (`GET /operations`)
      if (method === 'GET' && subPath === '/operations') {
        ctx.status = 200;
        ctx.body = await service.orchestrator.listOperations({
          tenantId: principal.tenantId,
          state: typeof ctx.query.state === 'string' ? ctx.query.state : undefined,
          businessId: typeof ctx.query.business === 'string' ? ctx.query.business : undefined,
          action: typeof ctx.query.action === 'string' ? ctx.query.action : undefined,
          from: typeof ctx.query.from === 'string' ? ctx.query.from : undefined,
          to: typeof ctx.query.to === 'string' ? ctx.query.to : undefined,
          limit: typeof ctx.query.limit === 'string' ? Number(ctx.query.limit) : undefined,
          cursor: typeof ctx.query.cursor === 'string' ? ctx.query.cursor : undefined,
          urlPrefix,
        });
        return;
      }

      // 5. Operation Detail / Cancel / Resume / Result
      const opDetailMatch = /^\/operations\/([^/]+)$/.exec(subPath);
      if (method === 'GET' && opDetailMatch) {
        const operationId = decodeURIComponent(opDetailMatch[1]);
        const waitSec = typeof ctx.query.wait === 'string' ? Number(ctx.query.wait) : 0;
        ctx.status = 200;
        ctx.body = await service.orchestrator.waitForOperation(principal.tenantId, operationId, waitSec, urlPrefix);
        return;
      }

      const opActionMatch = /^\/operations\/([^/]+)\/(cancel|resume|result)$/.exec(subPath);
      if (opActionMatch) {
        const operationId = decodeURIComponent(opActionMatch[1]);
        const subAction = opActionMatch[2];
        if (method === 'POST' && subAction === 'cancel') {
          const res = await service.orchestrator.cancelOperation(principal.tenantId, operationId);
          ctx.status = res.httpStatus;
          ctx.body = {
            operationId: res.operationId,
            state: res.state,
            stateVersion: res.stateVersion,
            replayed: res.replayed,
          };
          return;
        }
        if (method === 'POST' && subAction === 'resume') {
          const body = await readJsonBody(ctx);
          const resumeInput = isRecord(body.input) ? body.input : {};
          const res = await service.orchestrator.resumeOperation({
            tenantId: principal.tenantId,
            operationId,
            waitId: typeof body.waitId === 'string' ? body.waitId : undefined,
            expectedStateVersion:
              body.expectedStateVersion !== undefined ? Number(body.expectedStateVersion) : undefined,
            input: resumeInput,
            urlPrefix,
          });
          ctx.status = res.httpStatus;
          ctx.body = res;
          return;
        }
        if (method === 'GET' && subAction === 'result') {
          ctx.status = 200;
          ctx.body = await service.orchestrator.getOperationResult(principal.tenantId, operationId);
          return;
        }
      }

      // 6. Artifact Download (`GET /artifacts/:artifactId/download`)
      const artifactDownloadMatch = /^\/artifacts\/([^/]+)\/download$/.exec(subPath);
      if (method === 'GET' && artifactDownloadMatch) {
        const artifactId = decodeURIComponent(artifactDownloadMatch[1]);
        const record = await service.orchestrator.artifactStorage.getArtifactOrThrow(principal.tenantId, artifactId);
        const bytes = service.orchestrator.artifactStorage.readArtifactBuffer(record);
        ctx.status = 200;
        ctx.type = record.mimeType || 'application/octet-stream';
        ctx.set('Content-Length', String(bytes.length));
        ctx.set('Content-Disposition', `inline; filename="${encodeURIComponent(record.fileName)}"`);
        ctx.body = bytes;
        return;
      }

      // 7. Usage Summary & Events (`GET /usage/summary`, `GET /usage/events`)
      if (method === 'GET' && subPath === '/usage/summary') {
        ctx.status = 200;
        ctx.body = await service.orchestrator.getUsageSummary({
          tenantId: principal.tenantId,
          from: String(ctx.query.from || ''),
          to: String(ctx.query.to || ''),
        });
        return;
      }

      if (method === 'GET' && subPath === '/usage/events') {
        ctx.status = 200;
        ctx.body = await service.orchestrator.listUsageEvents({
          tenantId: principal.tenantId,
          operationId: typeof ctx.query.operationId === 'string' ? ctx.query.operationId : undefined,
          provider: typeof ctx.query.provider === 'string' ? ctx.query.provider : undefined,
          model: typeof ctx.query.model === 'string' ? ctx.query.model : undefined,
          action: typeof ctx.query.action === 'string' ? ctx.query.action : undefined,
          limit: typeof ctx.query.limit === 'string' ? Number(ctx.query.limit) : undefined,
        });
        return;
      }

      // 8. Legacy Compatibility Facade (`POST /docs/:action` & `POST /docs/workflows`)
      const legacyDocsMatch = /^\/docs\/([^/]+)$/.exec(subPath);
      if (method === 'POST' && legacyDocsMatch) {
        const target = decodeURIComponent(legacyDocsMatch[1]);
        await legacyMultipartUpload(ctx, async () => undefined);
        const rawFields = isRecord(ctx.request.body) ? ctx.request.body : {};
        const uploadedFiles = Array.isArray((ctx.request as Context['request'] & { files?: unknown }).files)
          ? (ctx.request as Context['request'] & { files: Array<Record<string, unknown>> }).files
          : [];

        const artifactRefs = [];
        for (const f of uploadedFiles) {
          if (Buffer.isBuffer(f.buffer)) {
            const created = await service.orchestrator.artifactStorage.createReadyArtifactFromBuffer({
              tenantId: principal.tenantId,
              fileName: String(f.originalname || 'upload.bin'),
              mimeType: String(f.mimetype || 'application/octet-stream'),
              buffer: f.buffer,
              userId: principal.userId,
            });
            artifactRefs.push({ artifactId: created.artifactId, role: 'input' as const });
          }
        }

        const parsedFields: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rawFields)) {
          if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
            try {
              parsedFields[k] = JSON.parse(v);
              continue;
            } catch {
              // Keep string value
            }
          }
          parsedFields[k] = v;
        }

        const isWorkflowFacade = target === 'workflows';
        const processName = String(parsedFields.process || 'disbursement');
        const businessId = isWorkflowFacade && processName === 'lc-checker' ? 'lc-checker' : 'document-core';
        const actionName = isWorkflowFacade ? processName : target;
        const syncMode = ctx.query.sync === 'true';

        const submitted = await service.orchestrator.submitOperation({
          principal,
          businessId,
          action: actionName,
          submission: {
            input: parsedFields,
            artifacts: artifactRefs,
          },
          idempotencyKey: ctx.get('Idempotency-Key') || undefined,
          correlationId,
          urlPrefix,
          waitCompletionMs: syncMode ? 30_000 : 0,
        });

        const latest = await service.orchestrator.getOperationRecordOrThrow(principal.tenantId, submitted.operationId);
        const isDone = latest.state === 'SUCCEEDED';
        ctx.status = isDone ? 200 : 202;
        ctx.body = {
          name: `operations/${submitted.operationId}`,
          done: isDone,
          metadata: {
            processor: actionName,
            state: latest.state,
            createdAt: latest.createdAt,
          },
          ...(isDone ? { result: latest.outputPayload } : {}),
        };
        return;
      }

      throw new DuHttpError(createProblem(404, 'NOT_FOUND', `Gateway route ${method} ${subPath} not found`));
    } catch (err: unknown) {
      const problem =
        err instanceof DuHttpError
          ? { ...err.problem, correlationId: err.problem.correlationId || correlationId }
          : createProblem(500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err), { correlationId });
      ctx.status = problem.status;
      ctx.type = 'application/problem+json';
      ctx.body = problem;
    }
  };
}
