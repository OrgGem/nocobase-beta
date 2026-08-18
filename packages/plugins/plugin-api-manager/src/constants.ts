export const APIM_ACL = 'pm.plugin-api-manager';
export const SETTINGS_KEY = 'api-manager';

export const APIM_PREFIX = '/api/apim/';
export const INBOUND_PREFIX = '/api/apim/inbound/';
export const OUTBOUND_PREFIX = '/api/apim/outbound/';

export const MASK = '••••••••';

export const DEFAULT_TIMEOUT_MS = 30000;
export const DEFAULT_MAX_BODY_MB = 10;
export const MAX_MAX_BODY_MB = 100;
export const MAX_RETRY_COUNT = 5;
export const DEFAULT_LOG_RETENTION_DAYS = 30;

export type RouteDirection = 'inbound' | 'outbound';
export type EncryptionMode = 'none' | 'aes-256-gcm' | 'pgp';
export type WireFormat = 'binary' | 'json';

export const ERROR_CODES = {
  TIMEOUT: 'APIM_TIMEOUT',
  UPSTREAM_ERROR: 'APIM_UPSTREAM_ERROR',
  DECRYPT_FAILED: 'APIM_DECRYPT_FAILED',
  UPSTREAM_DECRYPT_FAILED: 'APIM_UPSTREAM_DECRYPT_FAILED',
  SIGNATURE_INVALID: 'APIM_SIGNATURE_INVALID',
  CRYPTO_CONFIG: 'APIM_CRYPTO_CONFIG',
  BODY_TOO_LARGE: 'APIM_BODY_TOO_LARGE',
  ROUTE_NOT_FOUND: 'APIM_ROUTE_NOT_FOUND',
  UNAUTHORIZED: 'APIM_UNAUTHORIZED',
  FORBIDDEN: 'APIM_FORBIDDEN',
} as const;
