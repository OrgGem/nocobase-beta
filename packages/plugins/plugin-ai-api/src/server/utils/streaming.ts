import type { Context } from '@nocobase/actions';

export class AiApiClientDisconnectedError extends Error {
  readonly code = 'client_disconnected';
  constructor() {
    super('Client disconnected');
    this.name = 'AiApiClientDisconnectedError';
  }
}

export function isClientDisconnected(ctx: Context, error: unknown): boolean {
  return ctx.req.aborted === true || error instanceof AiApiClientDisconnectedError;
}

export function isStreamingRequested(value: unknown) {
  return value !== false;
}

export function createRequestAbortController(ctx: Context) {
  const controller = new AbortController();
  const abort = () => {
    if (!ctx.res.writableEnded) controller.abort(new AiApiClientDisconnectedError());
  };
  ctx.req.once('aborted', abort);
  ctx.res.once('close', abort);
  return {
    signal: controller.signal,
    dispose() {
      ctx.req.off('aborted', abort);
      ctx.res.off('close', abort);
    },
  };
}

export async function writeResponse(ctx: Context, data: string) {
  if (ctx.res.writableEnded || ctx.res.destroyed) return false;
  if (!ctx.res.write(data)) await waitForDrain(ctx);
  return true;
}

function waitForDrain(ctx: Context) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      ctx.res.off('drain', onDrain);
      ctx.res.off('close', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Client disconnected'));
    };
    ctx.res.once('drain', onDrain);
    ctx.res.once('close', onClose);
  });
}
