import { setTimeout as delay } from 'node:timers/promises';
import { Transform, type TransformCallback } from 'node:stream';

export interface ThrottleOptions {
  /** Maximum steady rate in bytes per second. 0 disables throttling. */
  bytesPerSecond: number;
  /** Initial burst allowance in bytes before the steady rate takes over. */
  burstBytes?: number;
  /** Stream highWaterMark, defaults to 64 KiB. */
  highWaterMark?: number;
}

interface PendingChunk {
  chunk: Buffer;
  callback: TransformCallback;
}

/**
 * A token-bucket based Transform stream that paces bytes flowing through it.
 * Chunks are queued and processed serially so token accounting stays
 * consistent, and Node applies backpressure upstream while a chunk waits for
 * bandwidth.
 */
export class Throttle extends Transform {
  private readonly ratePerMs: number;
  private readonly maxTokens: number;
  private readonly enabled: boolean;
  private readonly queue: PendingChunk[] = [];
  private tokens: number;
  private lastRefill: number;
  private processing = false;
  private pendingFlush: TransformCallback | undefined;

  constructor(options: ThrottleOptions) {
    super({ highWaterMark: options.highWaterMark ?? 64 * 1024 });
    this.ratePerMs = options.bytesPerSecond / 1000;
    this.enabled = options.bytesPerSecond > 0;
    this.maxTokens = options.burstBytes ?? 64 * 1024;
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.lastRefill = now;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.ratePerMs);
  }

  private async pace(bytes: number): Promise<void> {
    if (!this.enabled || bytes <= 0) return;
    this.refill();
    if (this.tokens < bytes) {
      const deficit = bytes - this.tokens;
      this.tokens = 0;
      const waitMs = Math.ceil(deficit / this.ratePerMs);
      if (waitMs > 0) await delay(waitMs);
      this.refill();
    }
    // The bucket may briefly go negative when timing is rounded; the next
    // refill absorbs that overshoot, which keeps the long-term rate correct.
    this.tokens -= bytes;
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const { chunk, callback } = this.queue.shift() ?? ({} as PendingChunk);
        if (!callback) break;
        try {
          await this.pace(chunk.length);
          callback(null, chunk);
        } catch (error: unknown) {
          callback(error instanceof Error ? error : new Error(String(error)));
          break;
        }
      }
    } finally {
      this.processing = false;
    }
    if (this.queue.length === 0 && this.pendingFlush) {
      const callback = this.pendingFlush;
      this.pendingFlush = undefined;
      callback();
    }
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.queue.push({ chunk, callback });
    this.drain().catch(() => undefined);
  }

  override _flush(callback: TransformCallback): void {
    this.pendingFlush = callback;
    this.drain().catch(() => undefined);
  }
}

/**
 * A semaphore-based limiter that restricts the number of concurrent
 * download operations. This prevents multiple simultaneous downloads
 * from overwhelming the server's network bandwidth.
 */
export class DownloadLimiter {
  private readonly maxConcurrent: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  /**
   * Acquire a download slot. Returns a release function that must be called
   * when the download completes (success or failure).
   */
  async acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return () => this.release();
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.active -= 1;
    if (this.queue.length > 0 && this.active < this.maxConcurrent) {
      const next = this.queue.shift();
      next?.();
    }
  }

  /**
   * Returns the current number of active downloads.
   */
  get activeCount(): number {
    return this.active;
  }

  /**
   * Returns the number of downloads waiting in queue.
   */
  get waitingCount(): number {
    return this.queue.length;
  }
}

/**
 * Global download limiter instance shared across all requests.
 * The concurrency limit should match `maxConcurrentRequests` from settings.
 */
export const globalDownloadLimiter = new DownloadLimiter(5);
