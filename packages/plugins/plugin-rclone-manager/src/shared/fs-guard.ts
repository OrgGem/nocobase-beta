// SPDX-License-Identifier: Apache-2.0

/**
 * Determine whether an Rclone `fs` specification targets the host's local
 * filesystem rather than a configured non-local remote.
 *
 * Examples treated as local:
 * - `""`, `.`, `..`, `/var/data`, `\data`, `relative/folder`
 * - Windows drive paths: `C:`, `C:/data`, `D:\backups`
 * - On-the-fly `:local` backend connection strings: `:local:`, `:local,one_file_system:/`
 *
 * Named remotes whose configured `type === 'local'` in `rclone.conf` are also
 * checked separately via `extractRemoteName` + the server's `/config/dump` map.
 */
const WRAPPER_COLON_BACKENDS = new Set([
  'local',
  'alias',
  'crypt',
  'chunker',
  'compress',
  'combine',
  'union',
  'hasher',
]);

export function isSyntacticLocalFs(fs: string): boolean {
  const trimmed = String(fs ?? '').trim();
  if (!trimmed) {
    return true;
  }

  // On-the-fly connection string `:backend,opts:path` — block wrapper backends (alias/crypt/etc.)
  // syntactically as local so targets like `:alias,remote=/etc:` cannot bypass `local-fs`.
  if (trimmed.startsWith(':')) {
    const match = /^:([a-zA-Z0-9_-]+)/.exec(trimmed);
    const backend = match?.[1]?.toLowerCase() ?? '';
    return !backend || WRAPPER_COLON_BACKENDS.has(backend);
  }

  // Windows drive letter (single ASCII letter before colon)
  if (/^[a-zA-Z]:(?:[/\\]|$)/.test(trimmed) || /^[a-zA-Z]:[^/\\]/.test(trimmed)) {
    return true;
  }

  const colonIdx = trimmed.indexOf(':');
  if (colonIdx <= 0) {
    return true;
  }

  const remoteName = trimmed.slice(0, colonIdx);
  if (remoteName.includes('/') || remoteName.includes('\\')) {
    return true;
  }

  return false;
}

const VALID_REMOTE_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;

/**
 * Return true when `fs` uses Rclone on-the-fly connection-string syntax
 * (`:backend,opts:path`) or inline parameter overrides (`remote,host=...:path`).
 * Configured remotes only allow `[a-zA-Z0-9._-]` before `:`.
 */
export function isConnectionStringOverride(fs: string): boolean {
  const trimmed = String(fs ?? '').trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith(':')) {
    return true;
  }
  // Windows drive paths like `C:/data` are local paths, not connection strings
  if (/^[a-zA-Z]:(?:[/\\]|$)/.test(trimmed)) {
    return false;
  }
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx <= 0) {
    return false;
  }
  const remotePart = trimmed.slice(0, colonIdx);
  // Inline comma parameter overrides (`remote,key_file=/etc/id_rsa,host=...:`) must still be caught even when option values contain `/` or `\`.
  if (/^[a-zA-Z0-9._-]+,/.test(remotePart)) {
    return true;
  }
  if (remotePart.includes('/') || remotePart.includes('\\')) {
    return false;
  }
  return !VALID_REMOTE_NAME_REGEX.test(remotePart);
}

/**
 * Extract the configured remote name from `<remoteName>:<subPath>`, or `null`
 * when `fs` is a syntactic local path or `:backend:` connection string.
 */
export function extractRemoteName(fs: string): string | null {
  const trimmed = String(fs ?? '').trim();
  if (!trimmed || isSyntacticLocalFs(trimmed) || isConnectionStringOverride(trimmed)) {
    return null;
  }
  const colonIdx = trimmed.indexOf(':');
  return colonIdx > 0 ? trimmed.slice(0, colonIdx) : null;
}

/**
 * Full check combining syntactic local path detection with the remote's
 * configured backend type from `rclone.conf` (so a remote of `type = local`
 * cannot bypass `pm.plugin-rclone-manager.local-fs`).
 */
export function isLocalFsTarget(fs: string, remoteTypes?: Readonly<Record<string, string>>): boolean {
  if (isSyntacticLocalFs(fs)) {
    return true;
  }
  const remoteName = extractRemoteName(fs);
  if (remoteName && remoteTypes) {
    return remoteTypes[remoteName]?.toLowerCase() === 'local';
  }
  return false;
}

export const WRAPPER_REMOTE_TYPES = new Set(['alias', 'crypt', 'chunker', 'compress', 'combine', 'union', 'hasher']);

/**
 * Extract upstream target specs (`remote` / `upstreams`) from a wrapper remote's parameters.
 */
export function extractWrapperTargets(params: Readonly<Record<string, unknown>>): string[] {
  const targets: string[] = [];
  for (const [rawKey, rawValue] of Object.entries(params)) {
    const key = rawKey.trim().toLowerCase();
    if (typeof rawValue !== 'string' || !rawValue.trim()) {
      continue;
    }
    if (key === 'remote') {
      targets.push(rawValue.trim());
    } else if (key === 'upstreams') {
      const tokens = rawValue.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
      for (const rawToken of tokens) {
        const unquoted = rawToken.replace(/^["']|["']$/g, '').trim();
        if (!unquoted) continue;
        // Strip `combine` `<mountName>=<upstream>` prefix when `=` precedes any `:`, `/`, `\`, or `,`
        const eqIdx = unquoted.indexOf('=');
        const colonIdx = unquoted.indexOf(':');
        const slashIdx = unquoted.search(/[/\\]/);
        const withoutPrefix =
          eqIdx > 0 &&
          !unquoted.slice(0, eqIdx).includes(',') &&
          (colonIdx === -1 || eqIdx < colonIdx) &&
          (slashIdx === -1 || eqIdx < slashIdx)
            ? unquoted.slice(eqIdx + 1).trim()
            : unquoted;
        const stripped = withoutPrefix.replace(/:(ro|nc)$/i, '').trim();
        if (stripped) {
          targets.push(stripped);
        }
      }
    }
  }
  return targets;
}

/**
 * Normalize an Rclone relative sub-path (`remote` parameter in `/operations/*`)
 * and reject `..` traversal segments when operating inside a bounded remote path.
 */
export function normalizeRemoteSubPath(subPath: string | null | undefined): string {
  const raw = String(subPath ?? '').replace(/\\/g, '/');
  if (!raw || raw === '/') {
    return '';
  }
  const segments = raw.split('/').filter((seg) => seg.length > 0 && seg !== '.');
  if (segments.some((seg) => seg === '..')) {
    throw new Error('Path traversal segment ".." is not allowed');
  }
  return segments.join('/');
}
