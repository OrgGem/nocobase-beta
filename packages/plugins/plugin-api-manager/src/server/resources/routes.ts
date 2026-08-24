import { randomUUID } from 'crypto';
import type { Application } from '@nocobase/server';
import type { Handlers } from '@nocobase/resourcer';
import { DEFAULT_TIMEOUT_MS } from '../../constants';
import { decryptPayload, encryptPayload } from '../services/crypto-adapter';
import { sha256Hex as sha256 } from '../services/hash';
import { buildOutboundForwardRequest } from '../services/outbound-pipeline';
import { forwardRequest } from '../services/proxy-engine';
import { capPayload, writeRequestLog } from '../services/request-logger';

function readBody(ctx: { request?: { body?: unknown } }): Record<string, unknown> {
  const body = ctx.request?.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

const PREVIEW_MAX_CHARS = 2000;

function preview(buffer: Buffer): string {
  const text = buffer.toString('utf8');
  return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text;
}

/**
 * Connectivity/config check for a route that mirrors the gateway pipeline:
 * - outbound: the payload is encrypted before forwarding and the response is
 *   decrypted before being previewed (exactly what the gateway does);
 * - inbound: the payload is sent as-is (the gateway decrypts partner requests
 *   before forwarding) and the response is run through the encrypt step to
 *   validate the crypto config, while the preview stays plaintext.
 * Every test run is also written to apiRequestLogs with path "ui-test" so it
 * is visible in Request Logs alongside real gateway traffic.
 */
export function registerRoutesResource(app: Application): void {
  const handlers: Handlers = {
    async test(ctx, next) {
      const filterByTk = ctx.action?.params?.filterByTk;
      if (filterByTk == null) {
        ctx.throw(400, 'filterByTk is required');
      }
      const repo = app.db.getRepository('apiRoutes');
      const route = await repo.findOne({ filterByTk });
      if (!route) {
        ctx.throw(404, 'Route not found');
      }

      const body = readBody(ctx);
      const payload = typeof body.payload === 'string' ? body.payload : '';
      const requestBuffer = Buffer.from(payload, 'utf8');
      const plaintextContentType =
        payload.trim().startsWith('{') || payload.trim().startsWith('[') ? 'application/json' : 'text/plain';

      const mode = String(route.get('encryptionMode') ?? 'none');
      const direction = String(route.get('direction') ?? 'outbound');
      const routeResponseEncrypted = route.get('responseEncrypted') !== false;

      const requestId = randomUUID();
      const startedAt = new Date();
      let responseBody = Buffer.alloc(0);
      let httpStatus = 502;
      let upstreamStatus: number | null = null;
      let attempt = 0;
      let logStatus: 'ok' | 'failed' = 'failed';
      let errorCode: string | null = null;
      let errorMessage: string | null = null;

      try {
        let outgoingBody = requestBuffer;
        let outgoingContentType = plaintextContentType;
        let headers: Record<string, string> = {};
        if (direction === 'outbound') {
          // Shared with the gateway router so the test request is built by
          // the exact same outbound encryption + HMAC + JWT pipeline.
          const forward = await buildOutboundForwardRequest(app, route, {
            body: requestBuffer,
            contentType: plaintextContentType,
            forwardUrl: String(route.get('targetUrl') ?? ''),
            staticHeaders: (route.get('staticHeaders') as { name: string; value: string }[] | undefined) ?? [],
          });
          outgoingBody = forward.body;
          outgoingContentType = forward.contentType;
          headers = forward.headers;
        }

        const result = await forwardRequest({
          url: String(route.get('targetUrl') ?? ''),
          method: String(route.get('method') ?? 'POST'),
          headers,
          body: outgoingBody,
          timeoutMs: Number(route.get('timeoutMs') ?? DEFAULT_TIMEOUT_MS),
          retryCount: 0,
          retryDelayMs: 0,
        });

        responseBody = result.body;
        upstreamStatus = result.status;
        attempt = result.attempt;

        let previewBody = result.body;
        let responseCryptoVerified = false;
        let wireError: { code: string; message: string } | null = null;
        if (mode !== 'none' && routeResponseEncrypted) {
          try {
            if (direction === 'outbound') {
              previewBody = (await decryptPayload(app, route, result.body, result.headers['content-type'])).body;
              responseCryptoVerified = true;
            } else {
              await encryptPayload(app, route, result.body, result.headers['content-type']);
              responseCryptoVerified = true;
            }
          } catch (error) {
            const err = error as { code?: string; message?: string };
            wireError = { code: err.code ?? 'APIM_CRYPTO_CONFIG', message: err.message ?? 'Crypto processing failed' };
          }
        }

        const ok = result.status < 400 && !wireError;
        httpStatus = result.status;
        logStatus = ok ? 'ok' : 'failed';
        errorCode = wireError?.code ?? null;
        errorMessage = wireError?.message ?? null;

        ctx.body = {
          ok,
          status: result.status,
          upstreamStatus: result.status,
          durationMs: Date.now() - startedAt.getTime(),
          attempt: result.attempt,
          requestEncrypted: mode !== 'none' && direction === 'outbound',
          responseEncrypted: responseCryptoVerified,
          errorCode,
          error: errorMessage,
          responsePreview: preview(previewBody),
        };
      } catch (error) {
        const err = error as { code?: string; message?: string; httpStatus?: number };
        httpStatus = err.httpStatus ?? 502;
        errorCode = err.code ?? 'APIM_UPSTREAM_ERROR';
        errorMessage = err.message ?? 'Request failed';
        ctx.body = {
          ok: false,
          status: httpStatus,
          upstreamStatus: null,
          durationMs: Date.now() - startedAt.getTime(),
          attempt: 0,
          requestEncrypted: false,
          responseEncrypted: false,
          errorCode,
          responsePreview: errorMessage,
        };
      }

      const finishedAt = new Date();
      const logPayloads = Boolean(route.get('logPayloads'));
      try {
        await writeRequestLog(app.db, {
          requestId,
          routeId: Number(route.get('id')),
          routeName: String(route.get('name') ?? ''),
          direction,
          method: String(route.get('method') ?? 'POST'),
          path: 'ui-test',
          partnerId: route.get('partnerId') == null ? null : Number(route.get('partnerId')),
          apiKeyId: null,
          clientIp: ctx.ip ?? null,
          userAgent: ctx.get?.('user-agent') || null,
          status: logStatus,
          httpStatus,
          upstreamStatus,
          attempt,
          errorCode,
          error: errorMessage,
          requestBytes: requestBuffer.length,
          responseBytes: responseBody.length,
          requestSha256: requestBuffer.length > 0 ? sha256(requestBuffer) : null,
          responseSha256: responseBody.length > 0 ? sha256(responseBody) : null,
          requestPayload: logPayloads ? capPayload(requestBuffer) : null,
          responsePayload: logPayloads ? capPayload(responseBody) : null,
          startedAt,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
        });
      } catch (logError) {
        app.logger?.warn?.(`[api-manager] failed to write test request log: ${(logError as Error).message}`);
      }
      await next();
    },
  };

  app.resourceManager.define({
    name: 'apiRoutes',
    actions: handlers,
  });
}
