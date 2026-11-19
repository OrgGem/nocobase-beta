// SPDX-License-Identifier: Apache-2.0

export const FILE_EXTENSIONS = [
  'doc',
  'docx',
  'xls',
  'xlsx',
  'pdf',
  'csv',
  'txt',
  'md',
  'json',
  'xml',
  'ppt',
  'pptx',
  'zip',
  'rar',
  '7z',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
];

export const FILE_EXTENSION_SET = new Set(FILE_EXTENSIONS);

const FILENAME_IN_TEXT_RE = new RegExp(
  `[^\\s"'<>()[\\]{}]+\\.(${FILE_EXTENSIONS.join('|')})(?=$|[\\s"'<>()[\\]{},.;:!?])`,
  'gi',
);

const SKILLHUB_MANIFEST_RE = /<!--skillhub:files\s+([\s\S]*?)-->/g;

export interface SkillHubManifestEntry {
  name: string;
  downloadUrl: string;
  mimetype?: string | null;
  size?: number | null;
  execId?: string | null;
}

export function stripFilenameNoise(value: string): string {
  return value
    .trim()
    .replace(/^[\s"'`(<[{]+/, '')
    .replace(/[\s"'`)>}\].,;:!?]+$/, '');
}

export function extractFilenameFromText(value: string): string {
  const text = stripFilenameNoise(value);
  if (!text) return '';

  const matches = Array.from(text.matchAll(FILENAME_IN_TEXT_RE));
  const lastMatch = matches[matches.length - 1];
  if (lastMatch?.[0]) {
    return stripFilenameNoise(lastMatch[0]);
  }

  return text;
}

export function getDisplayNameCandidates(displayName: string): string[] {
  const candidates = [displayName, extractFilenameFromText(displayName)]
    .map((value) => stripFilenameNoise(value))
    .filter(Boolean);

  return Array.from(new Set(candidates));
}

export function isKnownFileUrl(url?: string): boolean {
  if (!url || /^(mailto|tel|javascript):/i.test(url)) {
    return false;
  }
  return (
    url.includes('/api/attachments/') ||
    url.includes('/api/attachments:stream') ||
    url.includes('/api/filePreviewAuth:download') ||
    url.includes('/api/files/download/') ||
    url.includes('/api/worker-monitor/') ||
    url.includes('/api/skillHub:download') ||
    url.includes('/storage/uploads/') ||
    url.includes('amazonaws.com')
  );
}

export function decodeBase64Utf8(value: string): string {
  let base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8').decode(bytes);
  }
  return binary;
}

function collectMessageTexts(msg: unknown): string[] {
  const texts: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value) {
      texts.push(value);
    } else if (value && typeof value === 'object') {
      texts.push(JSON.stringify(value));
    }
  };

  if (!msg || typeof msg !== 'object') return texts;
  const record = msg as Record<string, unknown>;
  const content = record.content ?? record;
  if (typeof content === 'string') {
    push(content);
  } else if (content && typeof content === 'object') {
    const contentRecord = content as Record<string, unknown>;
    push(contentRecord.content);
    const toolCalls = contentRecord.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (tc && typeof tc === 'object') {
          push((tc as Record<string, unknown>).content);
        }
      }
    }
  }
  return texts;
}

function decodeManifestPayload(raw: string): string {
  let payload = raw.trim();
  if (payload.includes('\\"') && !payload.includes('"')) {
    payload = payload.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return payload;
}

/**
 * Build filename -> manifest entry map from all skillhub manifests in the conversation.
 * Later entries win so the most recent execution's URL is preferred.
 */
export function buildSkillHubManifestMap(messages: unknown[]): Map<string, SkillHubManifestEntry> {
  const map = new Map<string, SkillHubManifestEntry>();
  if (!Array.isArray(messages)) return map;

  for (const msg of messages) {
    for (const text of collectMessageTexts(msg)) {
      SKILLHUB_MANIFEST_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = SKILLHUB_MANIFEST_RE.exec(text)) !== null) {
        try {
          const entries = JSON.parse(decodeManifestPayload(match[1]));
          if (!Array.isArray(entries)) continue;
          for (const entry of entries) {
            if (entry?.name && entry?.downloadUrl) {
              map.set(String(entry.name).toLowerCase().trim(), entry as SkillHubManifestEntry);
            }
          }
        } catch {
          // ignore malformed manifest
        }
      }
    }
  }
  return map;
}

const manifestCache = new WeakMap<unknown[], { signature: string; map: Map<string, SkillHubManifestEntry> }>();

function getMessagesSignature(messages: unknown[]): string {
  const last = messages.length > 0 ? (messages[messages.length - 1] as Record<string, unknown> | undefined) : undefined;
  const lastContent = last?.content;
  const lastContentLen =
    typeof lastContent === 'string'
      ? lastContent.length
      : lastContent &&
          typeof lastContent === 'object' &&
          typeof (lastContent as Record<string, unknown>).content === 'string'
        ? ((lastContent as Record<string, unknown>).content as string).length
        : 0;
  return `${messages.length}:${String(last?.key ?? '')}:${String(last?.loading ?? '')}:${lastContentLen}`;
}

export function getCachedSkillHubManifestMap(messages: unknown[]): Map<string, SkillHubManifestEntry> {
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Map();
  }
  const signature = getMessagesSignature(messages);
  const cached = manifestCache.get(messages);
  if (cached && cached.signature === signature) {
    return cached.map;
  }
  const map = buildSkillHubManifestMap(messages);
  manifestCache.set(messages, { signature, map });
  return map;
}

export function findManifestEntryForName(
  displayName: string,
  manifestMap: Map<string, SkillHubManifestEntry>,
): SkillHubManifestEntry | null {
  if (!displayName || manifestMap.size === 0) return null;
  for (const candidate of getDisplayNameCandidates(displayName)) {
    const hit = manifestMap.get(candidate.toLowerCase().trim());
    if (hit) return hit;
  }
  return null;
}

export function findSkillHubUrlForFile(filename: string, messages: unknown[]): string | null {
  if (!filename || !Array.isArray(messages)) return null;
  const cleanFilename = filename.toLowerCase().trim();
  const baseOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://local';

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i] as Record<string, unknown> | null | undefined;
    if (!msg?.content) continue;
    const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    const regex = /\/api\/skillHub:download\?[^)\s"']+/g;
    const matches = contentStr.match(regex);
    if (!matches) continue;

    for (let j = matches.length - 1; j >= 0; j -= 1) {
      const match = matches[j];
      try {
        const cleanMatch = match.replace(/&amp;/g, '&');
        const url = new URL(cleanMatch, baseOrigin);
        const f = url.searchParams.get('f');
        const fn = url.searchParams.get('filename') || url.searchParams.get('name');

        let decodedName = '';
        if (f) {
          try {
            decodedName = decodeBase64Utf8(f);
          } catch {
            // ignore malformed base64
          }
        } else if (fn) {
          decodedName = decodeURIComponent(fn);
        }

        if (decodedName && decodedName.toLowerCase().trim() === cleanFilename) {
          return cleanMatch;
        }
      } catch {
        // ignore invalid URL
      }
    }
  }
  return null;
}

export function findLatestExecId(messages: unknown[]): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i] as Record<string, unknown> | null | undefined;
    if (!msg?.content) continue;
    const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    const match = contentStr.match(/execId=([a-zA-Z0-9_-]+)/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export function resolveDownloadUrl(urlOrPath: string, messages: unknown[]): string {
  if (!urlOrPath) return urlOrPath;

  if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
    return urlOrPath;
  }

  const cleanPath = urlOrPath.replace(/^sandbox:(?:\/\/)?/, '');

  if (cleanPath.startsWith('api/')) {
    return `/${cleanPath}`;
  }

  let isDownload = false;
  let filenamePath = cleanPath;
  if (cleanPath.startsWith('download/')) {
    isDownload = true;
    filenamePath = cleanPath.substring('download/'.length);
  } else if (cleanPath.startsWith('/download/')) {
    isDownload = true;
    filenamePath = cleanPath.substring('/download/'.length);
  }

  if (isDownload) {
    const filename = filenamePath;
    const manifestEntry = findManifestEntryForName(filename, getCachedSkillHubManifestMap(messages));
    if (manifestEntry?.downloadUrl) {
      return manifestEntry.downloadUrl;
    }
    const matchedUrl = findSkillHubUrlForFile(filename, messages);
    if (matchedUrl) {
      return matchedUrl;
    }
    const latestExecId = findLatestExecId(messages);
    if (latestExecId) {
      return `/api/skillHub:download?execId=${latestExecId}&filename=${encodeURIComponent(filename)}`;
    }
    return `/download/${filename}`;
  }

  if (!cleanPath.startsWith('/') && !cleanPath.includes(':')) {
    return `/${cleanPath}`;
  }

  return cleanPath;
}

export function rewriteMarkdownContent(content: string, messages: unknown[]): string {
  if (typeof content !== 'string') return content;

  let nextContent = content.replace(/\]\(((?:sandbox:(?:\/\/)?|\/?download\/)[^)]+)\)/g, (_match, p1) => {
    const resolved = resolveDownloadUrl(p1, messages);
    return `](${resolved})`;
  });

  nextContent = nextContent.replace(/href=["']((?:sandbox:(?:\/\/)?|\/?download\/)[^"']+)["']/g, (_match, p1) => {
    const resolved = resolveDownloadUrl(p1, messages);
    return `href="${resolved}"`;
  });

  return nextContent;
}
