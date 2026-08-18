import type { Application } from '@nocobase/server';
import type { Handlers } from '@nocobase/resourcer';
import { DEFAULT_TIMEOUT_MS } from '../../constants';
import { buildForwardHeaders, type StaticHeader } from '../services/header-rules';
import { forwardRequest } from '../services/proxy-engine';

function readBody(ctx: { request?: { body?: unknown } }): Record<string, unknown> {
  const body = ctx.request?.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

const PREVIEW_MAX_CHARS = 2000;

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
      const contentType =
        payload.trim().startsWith('{') || payload.trim().startsWith('[') ? 'application/json' : 'text/plain';

      const headers = buildForwardHeaders({
        incoming: {},
        staticHeaders: (route.get('staticHeaders') as StaticHeader[] | undefined) ?? [],
        contentType,
      });

      const startedAt = Date.now();
      try {
        const result = await forwardRequest({
          url: String(route.get('targetUrl') ?? ''),
          method: String(route.get('method') ?? 'POST'),
          headers,
          body: requestBuffer,
          timeoutMs: Number(route.get('timeoutMs') ?? DEFAULT_TIMEOUT_MS),
          retryCount: 0,
          retryDelayMs: 0,
        });
        const text = result.body.toString('utf8');
        ctx.body = {
          ok: result.status < 400,
          status: result.status,
          upstreamStatus: result.status,
          durationMs: Date.now() - startedAt,
          attempt: result.attempt,
          responsePreview: text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text,
        };
      } catch (error) {
        const err = error as { code?: string; message?: string; httpStatus?: number };
        ctx.body = {
          ok: false,
          status: err.httpStatus ?? 502,
          upstreamStatus: null,
          durationMs: Date.now() - startedAt,
          attempt: 0,
          errorCode: err.code ?? 'APIM_UPSTREAM_ERROR',
          responsePreview: err.message ?? 'Request failed',
        };
      }
      await next();
    },
  };

  app.resourceManager.define({
    name: 'apiRoutes',
    actions: handlers,
  });
}
