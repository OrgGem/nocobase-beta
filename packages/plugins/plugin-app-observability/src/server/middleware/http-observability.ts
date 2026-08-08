import type { MetricsStore } from '../metrics/metrics-store';
import { normalizeOperation, type ResolvedAction } from '../utils/route-normalizer';

interface ResponseLike {
  once(event: 'finish' | 'close', listener: () => void): void;
  off(event: 'finish' | 'close', listener: () => void): void;
  writableEnded?: boolean;
}
interface HttpContext {
  action?: ResolvedAction;
  path: string;
  status: number;
  type?: string;
  length?: number;
  request?: { length?: number };
  res: ResponseLike;
  state?: { currentUser?: { id?: string | number } };
  auth?: { user?: { id?: string | number } };
}
export type HttpMiddleware = (ctx: HttpContext, next: () => Promise<unknown>) => Promise<void>;

export function createHttpObservabilityMiddleware(
  store: MetricsStore,
  options: { enabled?: () => boolean; onActiveUser?: (identifier: string | number) => Promise<void> } = {},
): HttpMiddleware {
  return async (ctx, next) => {
    if (options.enabled && !options.enabled()) {
      await next();
      return;
    }
    const initialOperation = normalizeOperation(ctx.action, ctx.path);
    if (isInternal(initialOperation)) {
      await next();
      return;
    }
    const handle = store.start({ service: 'http', operation: initialOperation, streaming: false });
    let thrown = false;
    let completed = false;
    const finish = (status: 'succeeded' | 'failed' | 'cancelled' | 'rejected') => {
      if (completed) return;
      completed = true;
      cleanup();
      // `resourcer` populates ctx.action downstream of this middleware, so the
      // canonical `resource:action` name is only knowable once next() has run.
      handle.finish({
        status,
        bytesIn: ctx.request?.length,
        bytesOut: ctx.length,
        operation: normalizeOperation(ctx.action, ctx.path),
      });
    };
    const onFinish = () => finish(statusFor(ctx.status));
    const onClose = () => finish(ctx.res.writableEnded ? statusFor(ctx.status) : 'cancelled');
    const cleanup = () => {
      ctx.res.off('finish', onFinish);
      ctx.res.off('close', onClose);
    };
    ctx.res.once('finish', onFinish);
    ctx.res.once('close', onClose);
    try {
      await next();
    } catch (error) {
      thrown = true;
      finish('failed');
      throw error;
    } finally {
      const userId = ctx.state?.currentUser?.id ?? ctx.auth?.user?.id;
      if (userId != null) {
        store.observeActiveUser(userId);
        await options.onActiveUser?.(userId);
      }
      const streaming = ctx.type?.includes('text/event-stream');
      if (!streaming && !thrown && !completed) finish(statusFor(ctx.status));
    }
  };
}
function isInternal(operation: string): boolean {
  return operation.startsWith('appObservability');
}
function statusFor(status: number): 'succeeded' | 'failed' | 'rejected' {
  if (status >= 500) return 'failed';
  if (status >= 400) return 'rejected';
  return 'succeeded';
}
