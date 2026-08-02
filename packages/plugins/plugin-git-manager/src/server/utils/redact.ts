import { redactUrlUserInfo } from './url-security';

export const REDACTED_PAT = '••••••••';

const GIT_MANAGER_RESOURCE_SEGMENTS = new Set([
  'gitManager',
  'gitRepositories',
  'gitAccounts',
  'gitReviewFlows',
  'gitCodeReviews',
  'gitSubtreeConfigs',
  'gitSubtreeRuns',
]);

/**
 * Association routes use names such as `gitAccounts.1.repositories`, not the
 * raw collection name. Redact every Git Manager resource response so those
 * routes cannot bypass credential scrubbing merely because their name is
 * nested.
 */
export function isGitManagerResourceResponse(resourceName: unknown): boolean {
  return (
    typeof resourceName === 'string' &&
    resourceName.split(/[.[\],:/()=\s]+/).some((segment) => GIT_MANAGER_RESOURCE_SEGMENTS.has(segment))
  );
}

/**
 * Redact embedded credentials from URLs in arbitrary strings.
 * Matches `scheme://user:password@host` and replaces with `scheme://***:***@host`.
 * Used to scrub error messages before persisting them to the DB or
 * returning them to the client, since simple-git often echoes the
 * authenticated remote URL in stderr.
 */
export function redactPat(s: unknown): string {
  if (typeof s !== 'string') return s == null ? '' : String(s);
  return redactUrlUserInfo(s);
}

/**
 * Mutate `err.message` (and common fields where simple-git stashes stderr)
 * to remove any embedded PAT before the error propagates further.
 */
export function redactError<T>(err: T): T {
  if (!err || typeof err !== 'object') return err;
  const error = err as { message?: unknown; stderr?: unknown; stdout?: unknown };
  if (typeof error.message === 'string') error.message = redactPat(error.message);
  if (typeof error.stderr === 'string') error.stderr = redactPat(error.stderr);
  if (typeof error.stdout === 'string') error.stdout = redactPat(error.stdout);
  return err;
}

/**
 * Redact PAT fields anywhere in a serializable API response. Repository
 * responses can contain a nested `gitAccount` (and Sequelize's nested
 * `dataValues`), so a shallow top-level scrub is not sufficient.
 */
export function redactCredentialFields(value: unknown): void {
  const visited = new WeakSet<object>();

  const visit = (current: unknown): void => {
    if (!current || typeof current !== 'object' || visited.has(current)) {
      return;
    }
    visited.add(current);

    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }

    const record = current as Record<string, unknown>;
    for (const [key, nestedValue] of Object.entries(record)) {
      if (key === 'pat') {
        record[key] = REDACTED_PAT;
        continue;
      }
      if ((key === 'repoUrl' || key === 'baseUrl') && typeof nestedValue === 'string') {
        record[key] = redactUrlUserInfo(nestedValue);
        continue;
      }
      visit(nestedValue);
    }
  };

  visit(value);
}
