/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export const URL_USERINFO_NOT_ALLOWED = 'Credential-bearing URLs are not allowed';

export function assertAccountRepositoryUrl(repoUrl: string, baseUrl: string | null, provider: string): void {
  assertUrlHasNoUserInfo(repoUrl);
  const trustedUrl = baseUrl || (provider === 'github' ? 'https://github.com' : 'https://gitlab.com');
  assertUrlHasNoUserInfo(trustedUrl);
  let repository: URL;
  let account: URL;
  try {
    repository = new URL(repoUrl);
    account = new URL(trustedUrl);
  } catch {
    throw new Error('Invalid repository or account URL');
  }
  if (repository.protocol !== 'https:' || account.protocol !== 'https:') {
    throw new Error('Only HTTPS repository and account URLs are allowed');
  }
  if (repository.origin !== account.origin) {
    throw new Error('Repository URL must match the Git account origin');
  }
  // This plugin currently implements the public GitHub API, not GitHub Enterprise endpoints.
  if (provider === 'github' && repository.origin !== 'https://github.com') {
    throw new Error('GitHub accounts currently require github.com');
  }
}

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
