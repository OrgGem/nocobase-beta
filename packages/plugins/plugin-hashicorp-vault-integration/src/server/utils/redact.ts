const URL_CREDENTIALS = /(https?:\/\/)([^/:@\s]+):([^@\s]+)@/g;
// Vault token formats: hvs./hvb./hvr. (1.10+), s./b./r. (legacy)
const VAULT_TOKEN = /\b(?:hvs|hvb|hvr|s|b|r)\.[A-Za-z0-9_-]{20,}\b/g;

export function redactSecrets(input: unknown): string {
  if (typeof input !== 'string') return input == null ? '' : String(input);
  return input.replace(URL_CREDENTIALS, '$1***:***@').replace(VAULT_TOKEN, '***');
}

/**
 * Build a loggable/persistable message from an unknown (often axios) error
 * without dumping request config or headers, and with token values redacted.
 */
export function toSafeErrorMessage(err: unknown): string {
  if (!err || typeof err !== 'object') return redactSecrets(err) || 'Unknown error';
  const e = err as {
    message?: unknown;
    response?: { status?: number; data?: { errors?: unknown } };
  };
  const parts: string[] = [];
  if (typeof e.response?.status === 'number') parts.push(`HTTP ${e.response.status}`);
  const vaultErrors = e.response?.data?.errors;
  if (Array.isArray(vaultErrors) && vaultErrors.length > 0) {
    parts.push(vaultErrors.map((x) => String(x)).join('; '));
  } else if (typeof e.message === 'string' && e.message) {
    parts.push(e.message);
  }
  return redactSecrets(parts.join(': ')) || 'Unknown error';
}
