// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve a signed backend download path (which includes its HMAC query string)
 * against NocoBase's configured API base URL without percent-encoding `?`.
 */
export function resolveSignedDownloadUrl(baseUrl: string, origin: string, signedRelativePath: string): string {
  const resolvedBase = new URL(baseUrl || '/api/', origin);
  const cleanApiRoot = resolvedBase.pathname.replace(/\/+$/, '');
  const qIndex = signedRelativePath.indexOf('?');
  const pathOnly = qIndex >= 0 ? signedRelativePath.slice(0, qIndex) : signedRelativePath;
  const queryOnly = qIndex >= 0 ? signedRelativePath.slice(qIndex) : '';
  const strippedPath = pathOnly.replace(/^\/api\b/, '');
  resolvedBase.pathname = `${cleanApiRoot}${strippedPath.startsWith('/') ? strippedPath : `/${strippedPath}`}`;
  resolvedBase.search = '';
  return `${resolvedBase.toString()}${queryOnly}`;
}
