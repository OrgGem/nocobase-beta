export interface RegistryOperationLock {
  runExclusive<T>(operation: () => Promise<T>, ttl: number): Promise<T>;
}

export interface RegistryOperationLockManager {
  runExclusive?<T>(key: string, operation: () => Promise<T>, ttl: number): Promise<T>;
  tryAcquire(key: string, timeout?: number): Promise<RegistryOperationLock>;
}

export type RegistryLockAttempt<T> = { acquired: true; value: T } | { acquired: false };

const localLockQueues = new Map<string, Promise<void>>();

export function sourceOperationLockKey(sourceId: string): string {
  return `skill-registry:source:${sourceId}`;
}

export function packageOperationLockKey(packageId: string): string {
  return `skill-registry:package:${packageId}`;
}

export function packageIdentityLockKey(namespace: string, slug: string): string {
  return `skill-registry:package-identity:${namespace}/${slug}`;
}

export function artifactOperationLockKey(digest: string): string {
  return `skill-registry:artifact:${digest}`;
}

async function runWithLocalLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = localLockQueues.get(key) || Promise.resolve();
  let release = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  localLockQueues.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (localLockQueues.get(key) === tail) {
      localLockQueues.delete(key);
    }
  }
}

export async function runRegistryOperation<T>(
  lockManager: RegistryOperationLockManager | undefined,
  key: string,
  ttl: number,
  operation: () => Promise<T>,
): Promise<T> {
  if (lockManager?.runExclusive) {
    return lockManager.runExclusive(key, operation, ttl);
  }
  return runWithLocalLock(key, operation);
}

export async function tryRunRegistryOperation<T>(
  lockManager: RegistryOperationLockManager | undefined,
  key: string,
  ttl: number,
  operation: () => Promise<T>,
): Promise<RegistryLockAttempt<T>> {
  if (lockManager) {
    let lock: RegistryOperationLock;
    try {
      lock = await lockManager.tryAcquire(key, 0);
    } catch {
      return { acquired: false };
    }
    return { acquired: true, value: await lock.runExclusive(operation, ttl) };
  }

  if (localLockQueues.has(key)) {
    return { acquired: false };
  }
  return { acquired: true, value: await runWithLocalLock(key, operation) };
}
