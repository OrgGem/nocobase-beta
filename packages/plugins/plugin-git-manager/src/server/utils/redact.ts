/**
 * Redact embedded credentials from URLs in arbitrary strings.
 * Matches `scheme://user:password@host` and replaces with `scheme://***:***@host`.
 * Used to scrub error messages before persisting them to the DB or
 * returning them to the client, since simple-git often echoes the
 * authenticated remote URL in stderr.
 */
export function redactPat(s: unknown): string {
  if (typeof s !== 'string') return s == null ? '' : String(s);
  return s.replace(/(https?:\/\/)([^\/:@\s]+):([^@\s]+)@/g, '$1***:***@');
}

/**
 * Mutate `err.message` (and common fields where simple-git stashes stderr)
 * to remove any embedded PAT before the error propagates further.
 */
export function redactError<T>(err: T): T {
  if (!err || typeof err !== 'object') return err;
  const e: any = err;
  if (typeof e.message === 'string') e.message = redactPat(e.message);
  if (typeof e.stderr === 'string') e.stderr = redactPat(e.stderr);
  if (typeof e.stdout === 'string') e.stdout = redactPat(e.stdout);
  return err;
}
