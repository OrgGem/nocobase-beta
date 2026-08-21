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
