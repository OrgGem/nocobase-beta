import { ApimError } from './errors';
import { envInt } from './env';
import {
  ERROR_CODES,
  DEFAULT_CAPACITY_MAX_CONCURRENT_REQUESTS,
  DEFAULT_CAPACITY_MAX_TOTAL_BYTES,
  DEFAULT_CAPACITY_MAX_REQUEST_BYTES,
  DEFAULT_CAPACITY_QUEUE_SIZE,
  DEFAULT_CAPACITY_QUEUE_TIMEOUT_MS,
} from '../../constants';

/**
 * CapacityLimiter enforces two global ceilings on the gateway's in-flight work:
 *
 * 1. `maxConcurrentRequests` — how many gateway requests may be actively
 *    buffering/forwarding at the same time.
 * 2. `maxTotalBytes` — the sum of the in-flight request payload sizes
 *    (estimated from `Content-Length`). This is the guard that keeps a burst
 *    of large uploads from exhausting the process memory.
 *
 * When a request cannot be admitted immediately:
 * - if queueing is disabled or the waiting queue is full, it is rejected with
 *   `429 APIM_CAPACITY_EXCEEDED`;
 * - otherwise it is parked in a FIFO waiting queue and admitted as soon as
 *   capacity frees up, or rejected with `503 APIM_QUEUE_TIMEOUT` after
 *   `queueTimeoutMs`.
 *
 * The limiter is process-local (in-memory), matching the existing rate
 * limiter. For horizontal deployments use service-level connection/pod limits
 * or replace this adapter with a distributed implementation.
 */

export interface CapacityLimiterOptions {
  maxConcurrentRequests: number;
  maxTotalBytes: number;
  /** Hard ceiling for a single request's estimated size. 0 disables this guard. */
  maxRequestBytes: number;
  queueEnabled: boolean;
  queueSize: number;
  queueTimeoutMs: number;
}

export interface CapacityLimiterStats {
  activeRequests: number;
  activeBytes: number;
  queuedRequests: number;
}

export interface WaitDecision {
  admitted: boolean;
  bytes: number;
  queuedMs?: number;
}

interface Waiter {
  bytes: number;
  resolve: (lease: CapacityLease) => void;
  reject: (error: ApimError) => void;
  timer: NodeJS.Timeout;
  enqueuedAt: number;
}

export class CapacityLease {
  private released = false;
  private readonly limiter: CapacityLimiter;
  private readonly bytes: number;
  private readonly queuedMs: number | null;

  constructor(limiter: CapacityLimiter, bytes: number, queuedMs: number | null) {
    this.limiter = limiter;
    this.bytes = bytes;
    this.queuedMs = queuedMs;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.limiter.release(this.bytes);
  }

  getWaitDecision(): WaitDecision {
    return { admitted: true, bytes: this.bytes, queuedMs: this.queuedMs ?? undefined };
  }
}

export function capacityFullError(): ApimError {
  return new ApimError(
    ERROR_CODES.CAPACITY_EXCEEDED,
    'Gateway is at capacity and the request could not be queued',
    429,
  );
}

export function queueTimeoutError(): ApimError {
  return new ApimError(ERROR_CODES.QUEUE_TIMEOUT, 'Request was queued but no capacity became available in time', 503);
}

export class CapacityLimiter {
  private activeRequests = 0;
  private activeBytes = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private options: CapacityLimiterOptions) {}

  updateOptions(options: CapacityLimiterOptions): void {
    this.options = options;
    this.drainWaiters();
  }

  private canAdmit(bytes: number): boolean {
    if (this.activeRequests >= this.options.maxConcurrentRequests) return false;
    if (this.options.maxTotalBytes > 0 && this.activeBytes + bytes > this.options.maxTotalBytes) return false;
    return true;
  }

  private admit(bytes: number): void {
    this.activeRequests += 1;
    this.activeBytes += Math.max(0, Math.floor(bytes));
  }

  async acquire(bytes: number): Promise<CapacityLease> {
    const normalized = Math.max(0, Math.floor(bytes));

    if (this.options.maxRequestBytes > 0 && normalized > this.options.maxRequestBytes) {
      throw new ApimError(
        ERROR_CODES.BODY_TOO_LARGE,
        `Request size ${normalized} bytes exceeds the gateway limit ${this.options.maxRequestBytes} bytes`,
        413,
      );
    }

    if (this.options.maxTotalBytes > 0 && normalized > this.options.maxTotalBytes) {
      throw new ApimError(
        ERROR_CODES.BODY_TOO_LARGE,
        `Request size ${normalized} bytes exceeds the gateway total concurrency budget ${this.options.maxTotalBytes} bytes`,
        413,
      );
    }

    if (this.canAdmit(normalized)) {
      this.admit(normalized);
      return new CapacityLease(this, normalized, null);
    }

    if (!this.options.queueEnabled || this.waiters.length >= this.options.queueSize) {
      throw capacityFullError();
    }

    return new Promise<CapacityLease>((resolve, reject) => {
      const waiter: Waiter = {
        bytes: normalized,
        enqueuedAt: Date.now(),
        resolve: (lease) => {
          clearTimeout(waiter.timer);
          resolve(lease);
        },
        reject: (error) => {
          clearTimeout(waiter.timer);
          removeWaiter(this.waiters, waiter);
          reject(error);
        },
        timer: setTimeout(() => {
          removeWaiter(this.waiters, waiter);
          reject(queueTimeoutError());
        }, this.options.queueTimeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  release(bytes: number): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.activeBytes = Math.max(0, this.activeBytes - Math.max(0, Math.floor(bytes)));
    this.drainWaiters();
  }

  private drainWaiters(): void {
    while (this.waiters.length > 0) {
      const head = this.waiters[0];
      if (!this.canAdmit(head.bytes)) break;
      this.waiters.shift();
      this.admit(head.bytes);
      head.resolve(new CapacityLease(this, head.bytes, Date.now() - head.enqueuedAt));
    }
  }

  getStats(): CapacityLimiterStats {
    return {
      activeRequests: this.activeRequests,
      activeBytes: this.activeBytes,
      queuedRequests: this.waiters.length,
    };
  }
}

function removeWaiter(waiters: Waiter[], waiter: Waiter): void {
  const index = waiters.indexOf(waiter);
  if (index !== -1) waiters.splice(index, 1);
}

export function loadCapacityLimiterOptions(): CapacityLimiterOptions {
  return {
    maxConcurrentRequests: Math.max(
      1,
      envInt('APIM_MAX_CONCURRENT_REQUESTS', DEFAULT_CAPACITY_MAX_CONCURRENT_REQUESTS),
    ),
    maxTotalBytes: Math.max(0, envInt('APIM_MAX_TOTAL_BYTES', DEFAULT_CAPACITY_MAX_TOTAL_BYTES)),
    maxRequestBytes: Math.max(0, envInt('APIM_MAX_REQUEST_BYTES', DEFAULT_CAPACITY_MAX_REQUEST_BYTES)),
    queueEnabled: process.env.APIM_QUEUE_ENABLED !== 'false',
    queueSize: Math.max(0, envInt('APIM_QUEUE_SIZE', DEFAULT_CAPACITY_QUEUE_SIZE)),
    queueTimeoutMs: Math.max(1, envInt('APIM_QUEUE_TIMEOUT_MS', DEFAULT_CAPACITY_QUEUE_TIMEOUT_MS)),
  };
}
