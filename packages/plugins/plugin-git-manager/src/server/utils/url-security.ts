export const URL_USERINFO_NOT_ALLOWED = 'Credential-bearing URLs are not allowed';

function pathSegments(value: string): string[] {
  return value.split(/[.[\],:/()=\s'"]+/);
}

function parseStructuredValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function hasUrlUserInfo(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }

  try {
    const url = new URL(value.trim());
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

export function assertUrlHasNoUserInfo(value: unknown): void {
  if (hasUrlUserInfo(value)) {
    throw new Error(URL_USERINFO_NOT_ALLOWED);
  }
}

function containsUrlUserInfo(value: unknown, visited = new WeakSet<object>()): boolean {
  if (typeof value === 'string') {
    return hasUrlUserInfo(value);
  }
  if (!value || typeof value !== 'object' || visited.has(value)) {
    return false;
  }
  visited.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => containsUrlUserInfo(item, visited));
  }

  return Object.values(value as Record<string, unknown>).some((item) => containsUrlUserInfo(item, visited));
}

/**
 * Generic NocoBase actions can place values directly, inside `values`, or in
 * dotted/bracket paths that UpdateGuard normalizes later. Find userinfo only
 * when it belongs to one of the URL-bearing configuration fields.
 */
export function containsCredentialBearingUrlField(
  value: unknown,
  fieldNames: ReadonlySet<string>,
  visited = new WeakSet<object>(),
): boolean {
  if (typeof value === 'string') {
    const structuredValue = parseStructuredValue(value);
    return structuredValue ? containsCredentialBearingUrlField(structuredValue, fieldNames, visited) : false;
  }
  if (!value || typeof value !== 'object' || visited.has(value)) {
    return false;
  }
  visited.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => containsCredentialBearingUrlField(item, fieldNames, visited));
  }

  return Object.entries(value as Record<string, unknown>).some(([key, item]) => {
    if (pathSegments(key).some((segment) => fieldNames.has(segment)) && containsUrlUserInfo(item)) {
      return true;
    }
    return containsCredentialBearingUrlField(item, fieldNames, visited);
  });
}

/**
 * Preserve the rest of a URL while masking URL userinfo in legacy data or an
 * accidentally nested API response.
 */
export function redactUrlUserInfo(value: string): string {
  // Userinfo may itself contain an unescaped `@`; match through the final
  // authority `@` rather than stopping at the first one and leaking part of
  // a password in a malformed or legacy URL.
  return value.replace(/([a-z][a-z\d+.-]*:\/\/)([^/?#\s]+)@/gi, '$1***:***@');
}
