import type { Application } from '@nocobase/server';
import type { CapacityLimiterOptions } from './capacity-limiter';
import type { CircuitBreakerOptions } from './circuit-breaker';
import { envBool, envIntOptional } from './env';
import {
  DEFAULT_CAPACITY_MAX_CONCURRENT_REQUESTS,
  DEFAULT_CAPACITY_MAX_REQUEST_BYTES,
  DEFAULT_CAPACITY_MAX_TOTAL_BYTES,
  DEFAULT_CAPACITY_QUEUE_ENABLED,
  DEFAULT_CAPACITY_QUEUE_SIZE,
  DEFAULT_CAPACITY_QUEUE_TIMEOUT_MS,
  DEFAULT_CIRCUIT_BREAKER_COUNT_SERVER_ERRORS,
  DEFAULT_CIRCUIT_BREAKER_ENABLED,
  DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  DEFAULT_CIRCUIT_BREAKER_OPEN_DURATION_MS,
} from '../../constants';

/**
 * Runtime settings resolution for the gateway.
 *
 * Precedence: process.env > apiManagerSettings singleton row > built-in default.
 * This lets the Settings UI store day-to-day values while a deployment can
 * still pin any value through an environment variable. Env names match the
 * field labels shown in the UI.
 */

export interface GatewaySettings {
  capacity: CapacityLimiterOptions;
  circuitBreaker: CircuitBreakerOptions;
}

const ENV = {
  maxConcurrentRequests: 'APIM_MAX_CONCURRENT_REQUESTS',
  maxTotalBytes: 'APIM_MAX_TOTAL_BYTES',
  maxRequestBytes: 'APIM_MAX_REQUEST_BYTES',
  queueEnabled: 'APIM_QUEUE_ENABLED',
  queueSize: 'APIM_QUEUE_SIZE',
  queueTimeoutMs: 'APIM_QUEUE_TIMEOUT_MS',
  circuitBreakerEnabled: 'APIM_CIRCUIT_BREAKER_ENABLED',
  circuitBreakerFailureThreshold: 'APIM_CIRCUIT_BREAKER_FAILURE_THRESHOLD',
  circuitBreakerOpenDurationMs: 'APIM_CIRCUIT_BREAKER_OPEN_DURATION_MS',
  circuitBreakerCountServerErrors: 'APIM_CIRCUIT_BREAKER_COUNT_SERVER_ERRORS',
} as const;

function num(value: unknown, fallback: number, min: number): number {
  if (value == null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  const n = Number.isFinite(parsed) ? Math.floor(parsed) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value == null) return fallback;
  if (value === 0 || value === '0' || value === 'false') return false;
  return true;
}

type SettingsRow = {
  get(name: string): unknown;
} | null;

function toBoolSetting(row: SettingsRow, field: string, envName: string, fallback: boolean): boolean {
  return envBool(envName) ?? bool(row?.get(field), fallback);
}

function toIntSetting(row: SettingsRow, field: string, envName: string, fallback: number, min: number): number {
  return envIntOptional(envName) ?? num(row?.get(field), fallback, min);
}

function buildSettings(row: SettingsRow): GatewaySettings {
  return {
    capacity: {
      maxConcurrentRequests: toIntSetting(
        row,
        'maxConcurrentRequests',
        ENV.maxConcurrentRequests,
        DEFAULT_CAPACITY_MAX_CONCURRENT_REQUESTS,
        1,
      ),
      maxTotalBytes: toIntSetting(row, 'maxTotalBytes', ENV.maxTotalBytes, DEFAULT_CAPACITY_MAX_TOTAL_BYTES, 0),
      maxRequestBytes: toIntSetting(row, 'maxRequestBytes', ENV.maxRequestBytes, DEFAULT_CAPACITY_MAX_REQUEST_BYTES, 0),
      queueEnabled: toBoolSetting(row, 'queueEnabled', ENV.queueEnabled, DEFAULT_CAPACITY_QUEUE_ENABLED),
      queueSize: toIntSetting(row, 'queueSize', ENV.queueSize, DEFAULT_CAPACITY_QUEUE_SIZE, 0),
      queueTimeoutMs: toIntSetting(row, 'queueTimeoutMs', ENV.queueTimeoutMs, DEFAULT_CAPACITY_QUEUE_TIMEOUT_MS, 1),
    },
    circuitBreaker: {
      enabled: toBoolSetting(row, 'circuitBreakerEnabled', ENV.circuitBreakerEnabled, DEFAULT_CIRCUIT_BREAKER_ENABLED),
      failureThreshold: toIntSetting(
        row,
        'circuitBreakerFailureThreshold',
        ENV.circuitBreakerFailureThreshold,
        DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
        1,
      ),
      openDurationMs: toIntSetting(
        row,
        'circuitBreakerOpenDurationMs',
        ENV.circuitBreakerOpenDurationMs,
        DEFAULT_CIRCUIT_BREAKER_OPEN_DURATION_MS,
        1,
      ),
      countServerErrors: toBoolSetting(
        row,
        'circuitBreakerCountServerErrors',
        ENV.circuitBreakerCountServerErrors,
        DEFAULT_CIRCUIT_BREAKER_COUNT_SERVER_ERRORS,
      ),
    },
  };
}

const CACHE_TTL_MS = 5000;

/**
 * Resolve current gateway settings. A positive TTL caches the DB-backed row;
 * env vars are always read live so a redeploy/env change can take precedence
 * immediately.
 */
export async function resolveGatewaySettings(app: Application, ttlMs: number = CACHE_TTL_MS): Promise<GatewaySettings> {
  const cache = cacheForApp(app);
  const now = Date.now();
  if (cache.row && now - cache.loadedAt < ttlMs) {
    return buildSettings(cache.row);
  }

  let row: SettingsRow = null;
  try {
    const record = await app.db.getRepository('apiManagerSettings').findOne({});
    row = record as SettingsRow | null;
  } catch {
    // The settings collection may not be synced yet in isolated tests — fall
    // back to defaults (env vars are still evaluated by buildSettings).
    row = null;
  }
  cache.row = row;
  cache.loadedAt = now;
  return buildSettings(row);
}

interface SettingsCache {
  row: SettingsRow;
  loadedAt: number;
}

const appCaches = new WeakMap<object, SettingsCache>();

function cacheForApp(app: Application): SettingsCache {
  const existing = appCaches.get(app);
  if (existing) return existing;
  const created: SettingsCache = { row: null, loadedAt: 0 };
  appCaches.set(app, created);
  return created;
}
