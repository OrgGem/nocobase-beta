// SPDX-License-Identifier: Apache-2.0

export interface LockManagerLike {
  tryAcquire?: (
    key: string,
    timeout?: number,
  ) => Promise<{
    runExclusive: <T>(fn: () => Promise<T>, ttl: number) => Promise<T>;
  }>;
}

export interface LockableAppLike {
  lockManager?: LockManagerLike;
}

const fallbackLocks = new Map<string, Promise<void>>();

export function isLockContentionError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object' && typeof (error as { constructor?: unknown }).constructor === 'function') {
    const name = (error as { constructor?: { name?: string } }).constructor?.name;
    if (name === 'LockAcquireError' || name === 'LockAbortError') {
      return true;
    }
  }
  const msg = error instanceof Error ? error.message : String(error);
  return /lock (is locked|acquire timed out|acquire timeout|aborted)/i.test(msg);
}

async function runWithFallbackMutex<T>(key: string, fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  const start = Date.now();
  while (fallbackLocks.has(key)) {
    if (timeoutMs <= 0) {
      throw Object.assign(new Error('lock is locked'), { name: 'LockAcquireError' });
    }
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) {
      throw Object.assign(new Error('lock acquire timed out'), { name: 'LockAcquireError' });
    }
    const current = fallbackLocks.get(key);
    if (!current) break;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        current,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(Object.assign(new Error('lock acquire timed out'), { name: 'LockAcquireError' }));
          }, remaining);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fallbackLocks.set(key, gate);
  try {
    return await fn();
  } finally {
    if (fallbackLocks.get(key) === gate) {
      fallbackLocks.delete(key);
    }
    release();
  }
}

export async function runWithAppLock<T>(
  app: LockableAppLike | null | undefined,
  key: string,
  fn: () => Promise<T>,
  options?: { timeoutMs?: number; ttlMs?: number },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const ttlMs = options?.ttlMs ?? 30_000;
  if (typeof app?.lockManager?.tryAcquire === 'function') {
    const lock = await app.lockManager.tryAcquire(key, timeoutMs);
    return lock.runExclusive(fn, ttlMs);
  }
  return runWithFallbackMutex(key, fn, timeoutMs);
}
