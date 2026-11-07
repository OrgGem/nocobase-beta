export interface RedisLockCommandClient {
  set(key: string, value: string, options: { NX: true; PX: number }): Promise<string | Buffer | null>;
  sendCommand(command: string[]): Promise<unknown>;
}

export declare function tryAcquireLock(
  client: RedisLockCommandClient,
  key: string,
  ownerToken: string,
  ttlMs: number,
): Promise<boolean>;
export declare function verifyLockOwner(
  client: RedisLockCommandClient,
  key: string,
  ownerToken: string,
): Promise<boolean>;
export declare function renewLockOwner(
  client: RedisLockCommandClient,
  key: string,
  ownerToken: string,
  ttlMs: number,
): Promise<boolean>;
export declare function releaseLockOwner(
  client: RedisLockCommandClient,
  key: string,
  ownerToken: string,
): Promise<boolean>;
