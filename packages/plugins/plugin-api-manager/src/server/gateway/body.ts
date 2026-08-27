import type { Context } from 'koa';

function formatMb(bytes: number): string {
  return Math.round(bytes / (1024 * 1024)) + ' MB';
}

/**
 * Read the raw request body as a Buffer.
 *
 * The plugin disables the core koa-bodyparser for /api/apim/ routes, so this cap
 * is the one that governs gateway payload size. Rejects with a 413-style error
 * once maxBodyBytes is exceeded. Binary-safe (returns a Buffer, never decodes).
 *
 * NOTE: Listener cleanup is critical here — ctx.req is the raw Node IncomingMessage
 * shared across the Koa lifecycle. Any leftover listeners cause memory leaks and
 * double-fire (error/end) in downstream middleware. This function removes all
 * listeners after settle and uses a settled flag to guarantee at-most-once resolve/reject.
 */
export function getRawBodyBuffer(ctx: Pick<Context, 'req'>, maxBodyBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteCount = 0;
    let settled = false;

    const cleanup = () => {
      ctx.req.removeListener('data', onData);
      ctx.req.removeListener('end', onEnd);
      ctx.req.removeListener('error', onError);
    };

    const settleOnce = (
      resolveFn: (value: Buffer) => void,
      rejectFn: (reason: unknown) => void,
      action: () => void,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        action();
      } catch (err) {
        rejectFn(err);
      }
    };

    const onData = (chunk: Buffer) => {
      if (settled) return;
      try {
        byteCount += chunk.length;
        if (byteCount > maxBodyBytes) {
          // Drain instead of destroying the socket so the client receives our 413
          // response rather than an ECONNRESET.
          chunks.length = 0;
          ctx.req.resume();
          settleOnce(
            resolve,
            reject,
            () => {
              reject(
                Object.assign(
                  new Error('Request body too large (max ' + formatMb(maxBodyBytes) + ')'),
                  { statusCode: 413 },
                ),
              );
            },
          );
          return;
        }
        chunks.push(chunk);
      } catch (err) {
        settleOnce(resolve, reject, () => reject(err));
      }
    };

    const onEnd = () => {
      settleOnce(resolve, reject, () => resolve(Buffer.concat(chunks)));
    };

    const onError = (err: Error) => {
      settleOnce(resolve, reject, () => reject(err));
    };

    ctx.req.on('data', onData);
    ctx.req.on('end', onEnd);
    ctx.req.on('error', onError);
  });
}
