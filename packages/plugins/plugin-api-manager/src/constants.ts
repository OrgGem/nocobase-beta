export const APIM_ACL = 'pm.plugin-api-manager';
export const SETTINGS_KEY = 'api-manager';

export const APIM_PREFIX = '/api/apim/';
export const INBOUND_PREFIX = '/api/apim/inbound/';
export const OUTBOUND_PREFIX = '/api/apim/outbound/';

export const MASK = '••••••••';

export const DEFAULT_TIMEOUT_MS = 30000;
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 300000;
export const MAX_RETRY_DELAY_MS = 60000;
export const DEFAULT_MAX_BODY_MB = 10;
export const MAX_MAX_BODY_MB = 100;
export const MAX_RETRY_COUNT = 5;
export const DEFAULT_LOG_RETENTION_DAYS = 30;

// Gateway runtime defaults (capacity guard + circuit breaker). Kept in
// constants so the server services and the Settings UI read from one source.
export const DEFAULT_CAPACITY_MAX_CONCURRENT_REQUESTS = 50;
export const DEFAULT_CAPACITY_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export const DEFAULT_CAPACITY_MAX_REQUEST_BYTES = 0;
export const DEFAULT_CAPACITY_QUEUE_ENABLED = true;
export const DEFAULT_CAPACITY_QUEUE_SIZE = 1000;
export const DEFAULT_CAPACITY_QUEUE_TIMEOUT_MS = 30_000;
export const DEFAULT_CIRCUIT_BREAKER_ENABLED = true;
export const DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
export const DEFAULT_CIRCUIT_BREAKER_OPEN_DURATION_MS = 30_000;
export const DEFAULT_CIRCUIT_BREAKER_COUNT_SERVER_ERRORS = true;

/** Route names become outbound URL path segments and API-key scope suffixes. */
export const ROUTE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
/** API-key scopes: "inbound"/"outbound" optionally narrowed to one route name. */
export const API_KEY_SCOPE_PATTERN = /^(inbound|outbound)(:[A-Za-z0-9._-]+)?$/;

export type RouteDirection = 'inbound' | 'outbound';
export type EncryptionMode = 'none' | 'aes-256-gcm' | 'pgp' | 'rsa-oaep';
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
  METHOD_NOT_ALLOWED: 'APIM_METHOD_NOT_ALLOWED',
  UNAUTHORIZED: 'APIM_UNAUTHORIZED',
  FORBIDDEN: 'APIM_FORBIDDEN',
  HMAC_INVALID: 'APIM_HMAC_INVALID',
  JWT_INVALID: 'APIM_JWT_INVALID',
  RATE_LIMITED: 'APIM_RATE_LIMITED',
  IP_FORBIDDEN: 'APIM_IP_FORBIDDEN',
  CAPACITY_EXCEEDED: 'APIM_CAPACITY_EXCEEDED',
  CIRCUIT_OPEN: 'APIM_CIRCUIT_OPEN',
  QUEUE_TIMEOUT: 'APIM_QUEUE_TIMEOUT',
} as const;
