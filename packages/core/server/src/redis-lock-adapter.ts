/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { randomUUID } from 'crypto';
import type { ILock, ILockAdapter, Releaser } from '@nocobase/lock-manager';
import { LockAbortError, LockAcquireError } from '@nocobase/lock-manager';
import { createClient } from 'redis';
import type { Redis } from './redis-connection-manager';

const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
const RENEW_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';

const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;
const MAX_ACQUIRE_TIMEOUT_MS = 30_000;

export interface RedisLockAdapterOptions {
  /** Redis endpoint. When omitted, the application's shared connection is used. */
  url?: string;
  /**
   * Application-like host object. Only `name` (key namespacing) and an optional
   * `redisConnectionManager` / `logger` are read, so the adapter stays usable
   * from tests and from non-Application callers.
   */
  app?: {
    name?: string;
    logger?: {
      error: (message: string) => void;
    };
    redisConnectionManager?: {
      getConnection: (key?: string, config?: { connectionString?: string }) => Redis | null | undefined;
    };
  };
  /** Key namespace. Defaults to the application name, then `main`. */
  namespace?: string;
}

/**
 * Distributed lock adapter backed by Redis.
 *
 * Ownership is enforced with a per-acquisition token: release and renewal are
 * Lua scripts that compare the stored token before acting, so a process whose
 * lease already expired can never delete or extend a lock now held by another
 * node.
 *
 * This lives in core rather than in an optional plugin because the locking
 * strategy is selected by `LOCK_ADAPTER_DEFAULT`, which is read while the
 * `LockManager` is constructed — that is, before any plugin can register an
 * adapter. Registering it here makes `LOCK_ADAPTER_DEFAULT=redis` work on every
 * node regardless of which plugins are enabled or in which order they load.
 */
export class RedisLockAdapter implements ILockAdapter {
  private readonly client: Redis;
  private readonly ownsClient: boolean;
  private readonly namespace: string;
  private releaseScriptSha: string | null = null;
  private renewScriptSha: string | null = null;

  constructor(private readonly options: RedisLockAdapterOptions = {}) {
    const providedClient = options.url
      ? undefined
      : options.app?.redisConnectionManager?.getConnection(undefined, undefined);

    if (providedClient) {
      this.client = providedClient;
      this.ownsClient = false;
    } else {
      this.client = createClient({ url: options.url }) as Redis;
      // Without an 'error' listener a connection failure emits an unhandled
      // 'error' event and takes the process down.
      this.client.on('error', (error: Error) => {
        options.app?.logger?.error(`[RedisLockAdapter] Redis error: ${error.message}`);
      });
      this.ownsClient = true;
    }

    this.namespace = options.namespace || options.app?.name || 'main';
  }

  async connect(): Promise<void> {
    if (!this.client.isOpen) {
      await this.client.connect();
    }
  }

  async close(): Promise<void> {
    if (this.ownsClient && this.client.isOpen) {
      await this.client.quit();
    }
  }

  async acquire(key: string, ttl: number): Promise<Releaser> {
    const token = randomUUID();
    const redisKey = this.getKey(key);
    await this.acquireWithToken(redisKey, token, ttl, Math.min(Math.max(ttl, 1), MAX_ACQUIRE_TIMEOUT_MS));
    return this.createReleaser(redisKey, token);
  }

  async runExclusive<T>(key: string, fn: () => Promise<T>, ttl: number): Promise<T> {
    const token = randomUUID();
    const redisKey = this.getKey(key);
    const timeout = Math.min(Math.max(ttl, 1), MAX_ACQUIRE_TIMEOUT_MS);
    await this.acquireWithToken(redisKey, token, ttl, timeout);

    const release = this.createReleaser(redisKey, token);
    const lease = this.startRenewal(redisKey, token, ttl);

    try {
      const result = await fn();
      if (lease.error) {
        throw new LockAbortError('Distributed lock lease was lost', { cause: lease.error });
      }
      return result;
    } finally {
      lease.stop();
      await release();
    }
  }

  async tryAcquire(key: string, timeout = 0): Promise<ILock> {
    const token = randomUUID();
    const redisKey = this.getKey(key);
    await this.acquireWithToken(redisKey, token, Math.max(timeout, DEFAULT_ACQUIRE_TIMEOUT_MS), timeout);
    const release = this.createReleaser(redisKey, token);

    return {
      release,
      acquire: async (ttl: number) => {
        await this.renew(redisKey, token, ttl);
        return release;
      },
      extend: async (ttl: number) => {
        await this.renew(redisKey, token, ttl);
      },
      runExclusive: async <T>(fn: () => Promise<T>, ttl: number) => {
        await this.renew(redisKey, token, ttl);
        const lease = this.startRenewal(redisKey, token, ttl);
        try {
          const result = await fn();
          if (lease.error) {
            throw new LockAbortError('Distributed lock lease was lost', { cause: lease.error });
          }
          return result;
        } finally {
          lease.stop();
          await release();
        }
      },
    };
  }

  private startRenewal(redisKey: string, token: string, ttl: number) {
    const state: { error: Error | null; stop: () => void } = { error: null, stop: () => undefined };
    const timer = setInterval(
      () => {
        this.renew(redisKey, token, ttl)
          .then(() => {
            // A successful renewal heals an earlier transient failure.
            state.error = null;
          })
          .catch((error: unknown) => {
            state.error = error instanceof Error ? error : new Error(String(error));
          });
      },
      Math.max(100, Math.floor(ttl / 3)),
    );
    timer.unref?.();
    state.stop = () => clearInterval(timer);
    return state;
  }

  private async acquireWithToken(redisKey: string, token: string, ttl: number, timeout: number): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      const result = await this.client.set(redisKey, token, { NX: true, PX: ttl });
      if (result === 'OK') {
        return;
      }
      if (timeout === 0 || Date.now() - startedAt >= timeout) {
        throw new LockAcquireError(`Lock acquire timed out for key ${redisKey}`);
      }
      await this.sleep(20);
    }
  }

  private async renew(redisKey: string, token: string, ttl: number): Promise<void> {
    const result = await this.evalScript('renew', RENEW_SCRIPT, redisKey, token, String(ttl));
    if (Number(result) !== 1) {
      throw new LockAbortError(`Lock ${redisKey} is no longer owned by this process`, {});
    }
  }

  private createReleaser(redisKey: string, token: string): Releaser {
    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      await this.evalScript('release', RELEASE_SCRIPT, redisKey, token);
    };
  }

  /**
   * Run a cached Lua script. `EVALSHA` is attempted first and the script is
   * loaded on `NOSCRIPT`, which happens after a Redis restart or failover.
   */
  private async evalScript(
    kind: 'release' | 'renew',
    script: string,
    redisKey: string,
    ...args: string[]
  ): Promise<unknown> {
    const cached = kind === 'release' ? this.releaseScriptSha : this.renewScriptSha;
    if (cached) {
      try {
        return await this.client.sendCommand(['EVALSHA', cached, '1', redisKey, ...args]);
      } catch (error: unknown) {
        if (!this.isNoScriptError(error)) {
          throw error;
        }
      }
    }

    const sha = String(await this.client.sendCommand(['SCRIPT', 'LOAD', script]));
    if (kind === 'release') {
      this.releaseScriptSha = sha;
    } else {
      this.renewScriptSha = sha;
    }
    return this.client.sendCommand(['EVALSHA', sha, '1', redisKey, ...args]);
  }

  private isNoScriptError(error: unknown): boolean {
    return (error instanceof Error ? error.message : String(error)).includes('NOSCRIPT');
  }

  private getKey(key: string): string {
    return `nocobase:${this.namespace}:lock:${key}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}

export default RedisLockAdapter;
