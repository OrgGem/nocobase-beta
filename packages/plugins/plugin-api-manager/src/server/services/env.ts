import type { Application } from '@nocobase/server';

/**
 * Resolve an environment variable through the same chain the Crypto Toolkit
 * uses: NocoBase secret env vars (DB-stored) first, then process.env.
 *
 * The toolkit plugin exposes getEnvVal(); when it is unavailable (e.g. in
 * unit tests without a full app), fall back to process.env so HMAC/JWT
 * secret resolution keeps working in isolation.
 */

export function getEnv(app: Application, name: string): string | undefined {
  const toolkit = app.pm?.get?.('crypto-toolkit') as { getEnvVal?: (n: string) => string | undefined } | undefined;
  if (toolkit?.getEnvVal) {
    const value = toolkit.getEnvVal(name);
    if (value !== undefined) return value;
  }
  const fromProcess = process.env[name];
  return fromProcess == null ? undefined : fromProcess;
}

/**
 * Shared environment-variable helpers for the gateway's tunable knobs.
 *
 * Every knob resolves through the same chain: process.env (when present and
 * parseable) over the stored/default value provided by the caller. Keeping
 * the parsing here avoids three near-identical copies across the capacity
 * limiter, circuit breaker and settings resolver.
 */

/** Parse a non-negative integer env var; falls back when unset or invalid. */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/** Parse a non-negative integer env var; returns undefined when unset/invalid. */
export function envIntOptional(name: string): number | undefined {
  const raw = process.env[name];
  if (raw == null || raw === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
}

/** Parse a boolean env var; returns undefined when unset. */
export function envBool(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw == null || raw === '') return undefined;
  return raw !== 'false' && raw !== '0';
}
