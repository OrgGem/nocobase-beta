import type { Context } from 'koa';

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Read the raw request body as a Buffer.
 *
 * The plugin disables the core koa-bodyparser for /api/apim/ routes, so this cap
 * is the one that governs gateway payload size. Rejects with a 413-style error
 * once maxBodyBytes is exceeded. Binary-safe (returns a Buffer, never decodes).
 */
export function getRawBodyBuffer(ctx: Pick<Context, 'req'>, maxBodyBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteCount = 0;
    let aborted = false;

    ctx.req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      byteCount += chunk.length;
      if (byteCount > maxBodyBytes) {
        // Drain instead of destroying the socket so the client receives our 413
        // response rather than an ECONNRESET.
        aborted = true;
        chunks.length = 0;
        ctx.req.resume();
        reject(Object.assign(new Error(`Request body too large (max ${formatMb(maxBodyBytes)})`), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    ctx.req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });
    ctx.req.on('error', reject);
  });
}
