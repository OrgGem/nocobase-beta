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
  options: { enabled?: () => boolean } = {},
): HttpMiddleware {
  return async (ctx, next) => {
    if (options.enabled && !options.enabled()) {
      await next();
      return;
    }
    const operation = normalizeOperation(ctx.action, ctx.path);
    const internal = operation.startsWith('appObservability:');
    const handle = store.start({ service: 'http', operation, streaming: false });
    let thrown = false;
    let completed = false;
    const finish = (status: 'succeeded' | 'failed' | 'cancelled' | 'rejected') => {
      if (completed) return;
      completed = true;
      cleanup();
      handle.finish({ status, bytesIn: ctx.request?.length, bytesOut: ctx.length });
    };
    const onFinish = () => finish(statusFor(ctx.status));
    const onClose = () => finish(ctx.res.writableEnded ? statusFor(ctx.status) : 'cancelled');
    const cleanup = () => {
      ctx.res.off('finish', onFinish);
      ctx.res.off('close', onClose);
    };
    ctx.res.once('finish', onFinish);
    ctx.res.once('close', onClose);
    const userId = ctx.state?.currentUser?.id ?? ctx.auth?.user?.id;
    if (!internal && userId != null) store.observeActiveUser(userId);
    try {
      await next();
    } catch (error) {
      thrown = true;
      finish('failed');
      throw error;
    } finally {
      const streaming = ctx.type?.includes('text/event-stream');
      if (!streaming && !thrown && !completed) finish(statusFor(ctx.status));
    }
  };
}
function statusFor(status: number): 'succeeded' | 'failed' | 'rejected' {
  if (status >= 500) return 'failed';
  if (status >= 400) return 'rejected';
  return 'succeeded';
}
