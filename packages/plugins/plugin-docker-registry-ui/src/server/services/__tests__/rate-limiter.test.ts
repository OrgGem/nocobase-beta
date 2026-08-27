import { describe, expect, it } from 'vitest';
import { DownloadLimiter, Throttle, globalDownloadLimiter } from '../rate-limiter';

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

describe('DownloadLimiter', () => {
  it('allows concurrent downloads up to the limit', async () => {
    const limiter = new DownloadLimiter(2);
    
    const release1 = await limiter.acquire();
    expect(limiter.activeCount).toBe(1);
    expect(limiter.waitingCount).toBe(0);
    
    const release2 = await limiter.acquire();
    expect(limiter.activeCount).toBe(2);
    expect(limiter.waitingCount).toBe(0);
    
    release1();
    expect(limiter.activeCount).toBe(1);
    expect(limiter.waitingCount).toBe(0);
    
    release2();
    expect(limiter.activeCount).toBe(0);
    expect(limiter.waitingCount).toBe(0);
  });

  it('queues downloads when at capacity', async () => {
    const limiter = new DownloadLimiter(1);
    
    const release1 = await limiter.acquire();
    expect(limiter.activeCount).toBe(1);
    
    // This should queue
    let acquired = false;
    const acquirePromise = limiter.acquire().then((release) => {
      acquired = true;
      return release;
    });
    
    // Wait a bit to ensure the promise hasn't resolved yet
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(acquired).toBe(false);
    expect(limiter.waitingCount).toBe(1);
    
    // Release the first download
    release1();
    
    // The queued download should now acquire
    const release2 = await acquirePromise;
    expect(acquired).toBe(true);
    expect(limiter.activeCount).toBe(1);
    expect(limiter.waitingCount).toBe(0);
    
    release2();
    expect(limiter.activeCount).toBe(0);
  });

  it('processes queued downloads in FIFO order', async () => {
    const limiter = new DownloadLimiter(1);
    const order: number[] = [];
    
    const release1 = await limiter.acquire();
    
    // Queue multiple downloads
    const promise1 = limiter.acquire().then((release) => {
      order.push(1);
      return release;
    });
    const promise2 = limiter.acquire().then((release) => {
      order.push(2);
      return release;
    });
    const promise3 = limiter.acquire().then((release) => {
      order.push(3);
      return release;
    });
    
    // Release the first download
    release1();
    const release2 = await promise1;
    
    release2();
    const release3 = await promise2;
    
    release3();
    const release4 = await promise3;
    
    expect(order).toEqual([1, 2, 3]);
    
    release4();
  });

  it('globalDownloadLimiter is a singleton', () => {
    expect(globalDownloadLimiter).toBeInstanceOf(DownloadLimiter);
  });
});

async function collect(bytesPerSecond: number, size: number): Promise<number> {
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  
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
