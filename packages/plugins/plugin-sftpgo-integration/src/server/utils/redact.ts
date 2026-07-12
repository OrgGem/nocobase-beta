const URL_CREDENTIALS = /(https?:\/\/)([^/:@\s]+):([^@\s]+)@/g;
// SFTPGo JWT access tokens returned by GET /api/v2/token
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

export function redactSecrets(input: unknown): string {
  if (typeof input !== 'string') return input == null ? '' : String(input);
  return input.replace(URL_CREDENTIALS, '$1***:***@').replace(JWT_TOKEN, '***');
}

/**
 * Build a loggable/persistable message from an unknown (often axios) error
 * without dumping request config or headers, and with tokens redacted.
 */
export function toSafeErrorMessage(err: unknown): string {
  if (!err || typeof err !== 'object') return redactSecrets(err) || 'Unknown error';
  const e = err as {
    message?: unknown;
    response?: { status?: number; data?: { message?: unknown; error?: unknown } };
  };
  const parts: string[] = [];
  if (typeof e.response?.status === 'number') parts.push(`HTTP ${e.response.status}`);
  const data = e.response?.data;
  const sftpgoMessage = data?.message ?? data?.error;
  if (typeof sftpgoMessage === 'string' && sftpgoMessage) {
    parts.push(sftpgoMessage);
  } else if (typeof e.message === 'string' && e.message) {
    parts.push(e.message);
  }
  return redactSecrets(parts.join(': ')) || 'Unknown error';
}
