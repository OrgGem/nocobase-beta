import { randomUUID } from 'crypto';
import type { Context, Middleware } from 'koa';
import type { Application } from '@nocobase/server';
import type { Model } from '@nocobase/database';
import {
  DEFAULT_MAX_BODY_MB,
  DEFAULT_TIMEOUT_MS,
  ERROR_CODES,
  INBOUND_PREFIX,
  OUTBOUND_PREFIX,
  type RouteDirection,
} from '../../constants';
import { authenticateApiKey, type AuthResult } from './auth';
import { getRawBodyBuffer } from './body';
import { sha256Hex as sha256 } from '../services/crypto-primitives';
import { decryptPayload, encryptPayload } from '../services/crypto-adapter';
import { ApimError } from '../services/errors';
import { buildForwardHeaders, type StaticHeader } from '../services/header-rules';
import { forwardRequest } from '../services/proxy-engine';
import { writeRequestLog } from '../services/request-logger';

type GatewayContext = Context & { withoutDataWrapping?: boolean };

function sniffContentType(body: Buffer): string {
  for (const byte of body) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return byte === 0x7b || byte === 0x5b ? 'application/json' : 'application/octet-stream';
  }
  return 'application/octet-stream';
}

function toNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function resolveGatewayRoute(
  app: Application,
  direction: RouteDirection,
  pathOrName: string,
  method: string,
): Promise<Model> {
  const repo = app.db.getRepository('apiRoutes');
  const filter =
    direction === 'inbound'
      ? { direction: 'inbound', inboundPath: pathOrName }
      : { direction: 'outbound', name: pathOrName };
  const route = await repo.findOne({ filter });
  if (!route || !route.get('enabled')) {
    throw new ApimError(ERROR_CODES.ROUTE_NOT_FOUND, 'Route not found', 404);
  }
  if (String(route.get('method') ?? '').toUpperCase() !== method.toUpperCase()) {
    throw new ApimError(ERROR_CODES.ROUTE_NOT_FOUND, 'Method not allowed for this route', 405);
  }
  return route;
}

function toApimError(error: unknown): ApimError {
  if (error instanceof ApimError) return error;
  const statusCode = (error as { statusCode?: unknown })?.statusCode;
  if (typeof statusCode === 'number') {
    const code = statusCode === 413 ? ERROR_CODES.BODY_TOO_LARGE : ERROR_CODES.UPSTREAM_ERROR;
    return new ApimError(code, (error as Error).message, statusCode);
  }
  return new ApimError(ERROR_CODES.UPSTREAM_ERROR, (error as Error)?.message ?? 'Internal gateway error', 502);
}

export function createApimRouter(app: Application): Middleware {
  return async function apimRouter(ctx: GatewayContext, next) {
    const path = ctx.path;
    let direction: RouteDirection | null = null;
    let pathOrName = '';
    if (path.startsWith(INBOUND_PREFIX)) {
      direction = 'inbound';
      pathOrName = path.slice(INBOUND_PREFIX.length);
    } else if (path.startsWith(OUTBOUND_PREFIX)) {
      direction = 'outbound';
      pathOrName = path.slice(OUTBOUND_PREFIX.length);
    }
    if (!direction || !pathOrName) {
      return next();
    }

    ctx.withoutDataWrapping = true;
    const requestId = randomUUID();
    ctx.set('X-Request-Id', requestId);

    const startedAt = new Date();
    let route: Model | null = null;
    let auth: AuthResult | null = null;
    let requestBody = Buffer.alloc(0);
    let responseBody = Buffer.alloc(0);
    let httpStatus = 500;
    let upstreamStatus: number | null = null;
    let attempt = 0;
    let logStatus: 'ok' | 'rejected' | 'failed' = 'failed';
    let errorCode: string | null = null;
    let errorMessage: string | null = null;

    try {
      route = await resolveGatewayRoute(app, direction, pathOrName, ctx.method);
      const routeName = String(route.get('name') ?? '');

      auth = await authenticateApiKey(app.db, ctx.get('x-api-key'), direction, routeName);

      const maxBodyMb = Math.min(100, Math.max(1, toNumber(route.get('maxBodyMb'), DEFAULT_MAX_BODY_MB)));
      requestBody = await getRawBodyBuffer(ctx, maxBodyMb * 1024 * 1024);

      const mode = String(route.get('encryptionMode') ?? 'none');
      const requestContentType = ctx.get('content-type') || undefined;

      let outgoingBody = requestBody;
      let outgoingContentType = requestContentType;
      if (mode !== 'none') {
        if (direction === 'inbound') {
          outgoingBody = await decryptPayload(app, route, requestBody, requestContentType);
          outgoingContentType = sniffContentType(outgoingBody);
        } else {
          const encrypted = await encryptPayload(app, route, requestBody);
          outgoingBody = encrypted.body;
          outgoingContentType = encrypted.contentType ?? requestContentType;
        }
      }

      const headers = buildForwardHeaders({
        incoming: ctx.headers as Record<string, string | string[] | undefined>,
        forwardHeaders: (route.get('forwardHeaders') as string[] | undefined) ?? [],
        staticHeaders: (route.get('staticHeaders') as StaticHeader[] | undefined) ?? [],
        contentType: outgoingContentType,
      });

      const result = await forwardRequest({
        url: String(route.get('targetUrl') ?? ''),
        method: String(route.get('method') ?? 'POST'),
        headers,
        body: outgoingBody,
        timeoutMs: toNumber(route.get('timeoutMs'), DEFAULT_TIMEOUT_MS),
        retryCount: toNumber(route.get('retryCount'), 0),
        retryDelayMs: toNumber(route.get('retryDelayMs'), 1000),
      });
      attempt = result.attempt;
      upstreamStatus = result.status;

      let responseContentType = result.headers['content-type'];
      let finalBody = result.body;
      if (mode !== 'none') {
        if (direction === 'inbound') {
          const encrypted = await encryptPayload(app, route, result.body);
          finalBody = encrypted.body;
          responseContentType = encrypted.contentType ?? responseContentType;
        } else {
          try {
            finalBody = await decryptPayload(app, route, result.body, result.headers['content-type']);
          } catch (error) {
            if (error instanceof ApimError && error.code === ERROR_CODES.DECRYPT_FAILED) {
              throw new ApimError(ERROR_CODES.UPSTREAM_DECRYPT_FAILED, error.message, 502);
            }
            throw error;
          }
          responseContentType = sniffContentType(finalBody);
        }
      }

      responseBody = finalBody;
      httpStatus = result.status;
      logStatus = result.status < 400 ? 'ok' : 'failed';

      ctx.status = result.status;
      if (responseContentType) ctx.set('content-type', responseContentType);
      ctx.body = finalBody;
    } catch (error) {
      const apimError = toApimError(error);
      httpStatus = apimError.httpStatus;
      errorCode = apimError.code;
      errorMessage = apimError.message;
      logStatus = httpStatus >= 500 ? 'failed' : 'rejected';
      ctx.status = apimError.httpStatus;
      ctx.set('content-type', 'application/json');
      ctx.body = JSON.stringify({ error: { code: apimError.code, message: apimError.message, requestId } });
    } finally {
      const finishedAt = new Date();
      const logPayloads = Boolean(route?.get('logPayloads'));
      try {
        await writeRequestLog(app.db, {
          requestId,
          routeId: route ? Number(route.get('id')) : null,
          routeName: route ? String(route.get('name') ?? '') : pathOrName,
          direction,
          method: ctx.method,
          path,
          partnerId: auth?.partnerId ?? (route?.get('partnerId') == null ? null : Number(route.get('partnerId'))),
          apiKeyId: auth?.apiKeyId ?? null,
          clientIp: ctx.ip,
          userAgent: ctx.get('user-agent') || null,
          status: logStatus,
          httpStatus,
          upstreamStatus,
          attempt,
          errorCode,
          error: errorMessage,
          requestBytes: requestBody.length,
          responseBytes: responseBody.length,
          requestSha256: requestBody.length > 0 ? sha256(requestBody) : null,
          responseSha256: responseBody.length > 0 ? sha256(responseBody) : null,
          requestPayload: logPayloads && requestBody.length > 0 ? requestBody.toString('base64') : null,
          responsePayload: logPayloads && responseBody.length > 0 ? responseBody.toString('base64') : null,
          startedAt,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
        });
      } catch (logError) {
        app.logger?.warn?.(`[api-manager] failed to write request log: ${(logError as Error).message}`);
      }
    }
  };
}
