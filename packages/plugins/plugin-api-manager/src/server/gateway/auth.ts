import type { Database } from '@nocobase/database';
import { ERROR_CODES, type RouteDirection } from '../../constants';
import { hashApiKey } from '../services/key-manager';
import { ApimError } from '../services/errors';

export interface AuthResult {
  apiKeyId: number;
  partnerId: number | null;
  scopes: string[];
}

function hasScope(scopes: string[], direction: RouteDirection, routeName: string): boolean {
  return scopes.some((scope) => scope === direction || scope === `${direction}:${routeName}`);
}

export async function authenticateApiKey(
  db: Database,
  apiKeyHeader: string | undefined,
  direction: RouteDirection,
  routeName: string,
): Promise<AuthResult> {
  const presented = (apiKeyHeader ?? '').trim();
  if (!presented) {
    throw new ApimError(ERROR_CODES.UNAUTHORIZED, 'Missing X-API-Key header', 401);
  }

  const repo = db.getRepository('apiManagerApiKeys');
  const record = await repo.findOne({ filter: { keyHash: hashApiKey(presented), enabled: true } });
  if (!record) {
    throw new ApimError(ERROR_CODES.UNAUTHORIZED, 'Invalid API key', 401);
  }

  const expiresAt = record.get('expiresAt');
  if (expiresAt && new Date(expiresAt as string | Date).getTime() < Date.now()) {
    throw new ApimError(ERROR_CODES.UNAUTHORIZED, 'API key has expired', 401);
  }

  const revokedAt = record.get('revokedAt');
  if (revokedAt) {
    throw new ApimError(ERROR_CODES.UNAUTHORIZED, 'API key has been revoked', 401);
  }

  const rawScopes = record.get('scopes');
  const scopes: string[] = Array.isArray(rawScopes) ? rawScopes.map((s) => String(s)) : [];
  if (!hasScope(scopes, direction, routeName)) {
    throw new ApimError(ERROR_CODES.FORBIDDEN, `API key is not authorized for this ${direction} route`, 403);
  }

  const apiKeyId = Number(record.get('id'));
  const partnerIdValue = record.get('partnerId');
  const partnerId = partnerIdValue == null ? null : Number(partnerIdValue);

  try {
    await repo.update({ filterByTk: apiKeyId, values: { lastUsedAt: new Date() } });
  } catch {
    // lastUsedAt is best-effort; never fail auth because of it.
  }

  return { apiKeyId, partnerId, scopes };
}
