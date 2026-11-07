'use strict';

const VERIFY_SCRIPT = 'if redis.call("get", KEYS[1]) == ARGV[1] then return 1 else return 0 end';
const RENEW_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';
const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

async function tryAcquireLock(client, key, ownerToken, ttlMs) {
  const result = await client.set(key, ownerToken, { NX: true, PX: ttlMs });
  return result === 'OK' || (Buffer.isBuffer(result) && result.toString('utf8') === 'OK');
}

async function verifyLockOwner(client, key, ownerToken) {
  const result = await client.sendCommand(['EVAL', VERIFY_SCRIPT, '1', key, ownerToken]);
  return Number(result) === 1;
}

async function renewLockOwner(client, key, ownerToken, ttlMs) {
  const result = await client.sendCommand(['EVAL', RENEW_SCRIPT, '1', key, ownerToken, String(ttlMs)]);
  return Number(result) === 1;
}

async function releaseLockOwner(client, key, ownerToken) {
  const result = await client.sendCommand(['EVAL', RELEASE_SCRIPT, '1', key, ownerToken]);
  return Number(result) === 1;
}

module.exports = { tryAcquireLock, verifyLockOwner, renewLockOwner, releaseLockOwner };
