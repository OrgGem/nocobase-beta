import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { Throttle } from '../rate-limiter';

async function collect(bytesPerSecond: number, size: number): Promise<number> {
  const started = Date.now();
  const input = Readable.from([Buffer.alloc(size)]);
  const throttle = new Throttle({ bytesPerSecond, burstBytes: 0, highWaterMark: size });
  const chunks: Buffer[] = [];
  await pipeline(input, throttle, async (source) => {
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
  });
  const elapsedMs = Date.now() - started;
  expect(Buffer.concat(chunks).length).toBe(size);
  return elapsedMs;
}

describe('Throttle', () => {
  it('paces bytes to the configured rate', async () => {
    // 10 KB at 10 KB/s should take roughly 1 second (allow generous tolerance + overhead).
    const elapsedMs = await collect(10_000, 10_000);
    expect(elapsedMs).toBeGreaterThanOrEqual(500);
  });

  it('passes bytes through immediately when throttling is disabled', async () => {
    const elapsedMs = await collect(0, 8 * 1024);
    expect(elapsedMs).toBeLessThan(1000);
  });
});
