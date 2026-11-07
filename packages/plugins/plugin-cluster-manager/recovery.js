'use strict';

const { randomUUID } = require('node:crypto');
const { createClient } = require('redis');
const { tryAcquireLock, verifyLockOwner, renewLockOwner, releaseLockOwner } = require('./redis-lock-core');

const STARTUP_RECOVERY_LOCK_API_VERSION = 1;
const DEFAULT_TTL_MS = 30_000;

function assertSafeSegment(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
    throw new Error(`${name} must be a non-empty safe identifier`);
  }
}

function createStartupRecoveryLockClient(options) {
  if (!options || typeof options !== 'object') throw new Error('Startup recovery lock options are required');
  assertSafeSegment(options.appName, 'appName');
  assertSafeSegment(options.lockName, 'lockName');
  if (!options.client && (typeof options.redisUrl !== 'string' || options.redisUrl.length === 0)) {
    throw new Error('redisUrl or an existing Redis client is required');
  }

  const ttlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 5_000 || ttlMs > 300_000) {
    throw new Error('ttlMs must be an integer between 5000 and 300000');
  }

  const key = `nocobase:${options.appName}:lock:${options.lockName}`;
  const ownsClient = !options.client;
  const client = options.client || createClient({ url: options.redisUrl, socket: { connectTimeout: 5_000 } });
  const registryUrl = options.registryRedisUrl || options.redisUrl;
  const registryClient =
    options.registryClient ||
    (registryUrl === options.redisUrl
      ? client
      : createClient({
          url: registryUrl,
          socket: { connectTimeout: 5_000 },
        }));
  if (typeof client.on === 'function') {
    client.on('error', (error) => {
      options.onError?.(error);
    });
  }
  if (registryClient !== client && typeof registryClient.on === 'function') {
    registryClient.on('error', (error) => {
      options.onError?.(error);
    });
  }
  let closed = false;
  let connecting;
  let registryConnecting;

  async function ensureConnected() {
    if (closed) throw new Error('Startup recovery lock client is closed');
    if (client.isOpen) return;
    if (typeof client.connect !== 'function') throw new Error('The supplied Redis client is not connected');
    if (!connecting) {
      connecting = client.connect().finally(() => {
        connecting = undefined;
      });
    }
    await connecting;
  }

  async function ensureRegistryConnected() {
    if (closed) throw new Error('Startup recovery lock client is closed');
    if (registryClient.isOpen) return;
    if (typeof registryClient.connect !== 'function')
      throw new Error('The supplied registry Redis client is not connected');
    if (!registryConnecting) {
      registryConnecting = registryClient.connect().finally(() => {
        registryConnecting = undefined;
      });
    }
    await registryConnecting;
  }

  return {
    apiVersion: STARTUP_RECOVERY_LOCK_API_VERSION,
    key,
    async tryAcquire(ownerToken = randomUUID()) {
      if (typeof ownerToken !== 'string' || ownerToken.length < 16 || ownerToken.length > 200) {
        throw new Error('ownerToken must contain between 16 and 200 characters');
      }
      await ensureConnected();
      if (!(await tryAcquireLock(client, key, ownerToken, ttlMs))) return null;

      let released = false;
      return {
        ownerToken,
        async verify() {
          if (released) return false;
          await ensureConnected();
          return verifyLockOwner(client, key, ownerToken);
        },
        async renew() {
          if (released) return false;
          await ensureConnected();
          return renewLockOwner(client, key, ownerToken, ttlMs);
        },
        async release() {
          if (released) return false;
          released = true;
          await ensureConnected();
          return releaseLockOwner(client, key, ownerToken);
        },
      };
    },
    async listClusterManagerNodes() {
      await ensureRegistryConnected();
      const prefix = `nocobase:${options.appName}:cluster-manager:nodes:`;
      const keys = [];
      let cursor = '0';
      do {
        const page = await registryClient.sendCommand(['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', '100']);
        if (!Array.isArray(page) || page.length !== 2 || !Array.isArray(page[1])) {
          throw new Error('Cluster Manager node registry returned an invalid SCAN response');
        }
        cursor = String(page[0]);
        keys.push(...page[1].map(String));
      } while (cursor !== '0');
      if (keys.length === 0) return [];
      const values = await registryClient.sendCommand(['MGET', ...keys]);
      if (!Array.isArray(values) || values.length !== keys.length) {
        throw new Error('Cluster Manager node registry returned an incomplete node list');
      }
      return values.flatMap((value) => {
        if (typeof value !== 'string') return [];
        let node;
        try {
          node = JSON.parse(value);
        } catch {
          throw new Error('Cluster Manager node registry contains malformed metadata');
        }
        if (!node || typeof node !== 'object' || typeof node.id !== 'string' || typeof node.workerMode !== 'string') {
          throw new Error('Cluster Manager node registry contains incomplete metadata');
        }
        return [
          {
            id: node.id,
            workerMode: node.workerMode,
            appRole: typeof node.appRole === 'string' ? node.appRole : undefined,
            isSandbox: node.isSandbox === true,
          },
        ];
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      if (connecting) await connecting.catch(() => undefined);
      if (registryConnecting) await registryConnecting.catch(() => undefined);
      if (ownsClient && client.isOpen && typeof client.quit === 'function') await client.quit();
      if (
        registryClient !== client &&
        !options.registryClient &&
        registryClient.isOpen &&
        typeof registryClient.quit === 'function'
      ) {
        await registryClient.quit();
      }
    },
  };
}

module.exports = {
  STARTUP_RECOVERY_LOCK_API_VERSION,
  createStartupRecoveryLockClient,
};
