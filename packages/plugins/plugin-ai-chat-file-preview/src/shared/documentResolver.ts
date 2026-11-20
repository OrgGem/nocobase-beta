// SPDX-License-Identifier: Apache-2.0

import type { ChatBoxRuntime } from '@nocobase/plugin-ai/client-v2';
import type { ChatScope } from './chatScope';
import {
  decodeBase64Utf8,
  extractFilenameFromText,
  getDisplayNameCandidates,
  stripFilenameNoise,
  type SkillHubManifestEntry,
} from './fileLinks';

export type DocumentPreviewRecordCollection = 'aiFiles' | 'attachments';

export type DocumentPreviewSource =
  | {
      kind: 'record';
      collection: DocumentPreviewRecordCollection;
      id: string | number;
      displayName?: string;
    }
  | {
      kind: 'skillHub';
      execId: string;
      filename: string;
      displayName?: string;
    };

export interface DocumentPreviewPluginLike {
  openDocumentPreview?: (source: DocumentPreviewSource) => unknown;
}

export interface ChatPreviewAppLike {
  name?: string;
  apiClient?: {
    appName?: string;
    axios?: {
      defaults?: {
        baseURL?: string;
      };
    };
    getHeaders?: () => Record<string, string | undefined>;
  };
  pm?: {
    get?: (name: string) => unknown;
  };
  i18n?: {
    t: (key: string, options?: Record<string, unknown>) => string;
  };
}

interface AppRouteContext {
  origin: string;
  appName: string;
  apiBasePath: string;
  publicPath: string;
}

interface ChatSessionSnapshot {
  attachments?: unknown[];
  messages?: unknown[];
}

interface ChatMessageModelLike {
  getSessionState?: (sessionId?: string) => ChatSessionSnapshot;
  sessions?: Record<string, ChatSessionSnapshot>;
}

const SUPPORTED_COLLECTIONS = new Set<DocumentPreviewRecordCollection>(['aiFiles', 'attachments']);
const CHAT_DEFAULT_SESSION_KEY = '__draft__';
const SKILLHUB_MANIFEST_RE = /<!--skillhub:files\s+([\s\S]*?)-->/g;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'ico',
  'avif',
  'heic',
  'heif',
  'tif',
  'tiff',
]);

const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'm4v', 'wmv', 'flv', '3gp']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return false;
  }
  return true;
}

function readString(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value : '';
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

function normalizePathPrefix(raw: string): string {
  const trimmed = trimSlashes(raw.trim());
  return trimmed ? `/${trimmed}` : '';
}

export function getAppRouteContext(app?: ChatPreviewAppLike): AppRouteContext {
  const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://local';
  const headers = app?.apiClient?.getHeaders?.() || {};
  const appName =
    (typeof app?.name === 'string' && app.name.trim()) ||
    (typeof app?.apiClient?.appName === 'string' && app.apiClient.appName.trim()) ||
    (typeof headers['X-App'] === 'string' && headers['X-App'].trim()) ||
    'main';

  let apiBasePath = '/api';
  const rawBaseUrl = app?.apiClient?.axios?.defaults?.baseURL;
  if (typeof rawBaseUrl === 'string' && rawBaseUrl.trim()) {
    try {
      const parsed = new URL(rawBaseUrl, origin);
      apiBasePath = normalizePathPrefix(parsed.pathname) || '/api';
    } catch {
      apiBasePath = normalizePathPrefix(rawBaseUrl) || '/api';
    }
  }

  let publicPath = '';
  if (typeof window !== 'undefined') {
    const win = window as Window & {
      __nocobase_dev_public_path__?: string;
      __nocobase_public_path__?: string;
    };
    const rawPublic = win.__nocobase_dev_public_path__ || win.__nocobase_public_path__ || '';
    if (typeof rawPublic === 'string' && rawPublic.trim()) {
      try {
        publicPath = normalizePathPrefix(new URL(rawPublic, origin).pathname);
      } catch {
        publicPath = normalizePathPrefix(rawPublic);
      }
    }
  }

  return { origin, appName, apiBasePath, publicPath };
}

function getExtension(value?: string): string {
  if (!value) return '';
  const clean = value.split('?')[0].split('#')[0].trim();
  const dot = clean.lastIndexOf('.');
  if (dot <= 0 || dot === clean.length - 1) return '';
  return clean.slice(dot + 1).toLowerCase();
}

export function isMediaExcluded(filename?: string, mimeType?: string, element?: Element | null): boolean {
  if (element && element.closest('img, video, .ant-image')) {
    return true;
  }
  const normalizedMime = (mimeType || '').split(';')[0].trim().toLowerCase();
  if (normalizedMime.startsWith('image/') || normalizedMime.startsWith('video/')) {
    return true;
  }
  const ext = getExtension(filename);
  if (ext && (IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext))) {
    return true;
  }
  return false;
}

function isValidRecordId(value: unknown): value is string | number {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0;
  }
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('rc-upload-')) return false;
  if (trimmed.includes('/') || trimmed.startsWith('http://') || trimmed.startsWith('https://')) return false;
  return true;
}

function isSupportedCollection(value: string): value is DocumentPreviewRecordCollection {
  return SUPPORTED_COLLECTIONS.has(value as DocumentPreviewRecordCollection);
}

function parseSameOriginUrl(rawHref: string, origin: string): URL | null {
  const trimmed = rawHref.trim();
  if (!trimmed || /^(mailto|tel|javascript|blob|data):/i.test(trimmed)) {
    return null;
  }
  try {
    const parsed = new URL(trimmed, origin);
    if (parsed.origin !== origin) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function stripPublicPath(pathname: string, publicPath: string): string {
  if (publicPath && (pathname === publicPath || pathname.startsWith(`${publicPath}/`))) {
    return pathname.slice(publicPath.length) || '/';
  }
  return pathname;
}

function isMatchingApiPath(pathname: string, apiBasePath: string, suffix: string): boolean {
  const normalizedPath = pathname.replace(/\/+$/, '');
  const expected = `${apiBasePath}/${suffix.replace(/^\/+/, '')}`;
  return normalizedPath === expected;
}

export function parseSkillHubDocumentUrl(
  rawHref: string,
  appContext: AppRouteContext,
  displayName?: string,
): DocumentPreviewSource | null {
  const parsed = parseSameOriginUrl(rawHref, appContext.origin);
  if (!parsed) return null;

  if (!isMatchingApiPath(parsed.pathname, appContext.apiBasePath, 'skillHub:download')) {
    return null;
  }

  const execId = (parsed.searchParams.get('execId') || '').trim();
  if (!execId) return null;

  let filename = '';
  const fParam = parsed.searchParams.get('f');
  if (fParam) {
    try {
      filename = decodeBase64Utf8(fParam).trim();
    } catch {
      return null;
    }
  } else {
    const rawName = parsed.searchParams.get('filename') || parsed.searchParams.get('name') || '';
    filename = rawName.trim();
  }

  if (!filename) return null;
  if (isMediaExcluded(filename) || isMediaExcluded(displayName)) {
    return null;
  }

  return {
    kind: 'skillHub',
    execId,
    filename,
    displayName: (displayName && stripFilenameNoise(displayName)) || filename,
  };
}

export function parseFileManagerDocumentUrl(
  rawHref: string,
  appContext: AppRouteContext,
  displayName?: string,
): DocumentPreviewSource | null {
  const parsed = parseSameOriginUrl(rawHref, appContext.origin);
  if (!parsed) return null;

  const cleanDisplayName = displayName ? stripFilenameNoise(displayName) : '';
  const pathWithoutPublic = stripPublicPath(parsed.pathname, appContext.publicPath);
  const segments = pathWithoutPublic.split('/').filter(Boolean);

  // 1) Permanent File Manager URL: /files/:appName/:dataSourceKey/:collectionName/:id[.ext]
  if (segments[0] === 'files' && segments.length === 5) {
    let appName: string;
    let dataSourceKey: string;
    let collectionName: string;
    let fileIdSegment: string;
    try {
      appName = decodeURIComponent(segments[1]);
      dataSourceKey = decodeURIComponent(segments[2]);
      collectionName = decodeURIComponent(segments[3]);
      fileIdSegment = decodeURIComponent(segments[4]);
    } catch {
      return null;
    }

    if (
      !IDENTIFIER_PATTERN.test(appName) ||
      !IDENTIFIER_PATTERN.test(dataSourceKey) ||
      !IDENTIFIER_PATTERN.test(collectionName)
    ) {
      return null;
    }
    if (appName !== appContext.appName || dataSourceKey !== 'main' || !isSupportedCollection(collectionName)) {
      return null;
    }

    const dotIndex = fileIdSegment.lastIndexOf('.');
    const ext = dotIndex > 0 ? fileIdSegment.slice(dotIndex + 1).toLowerCase() : '';
    const id = dotIndex > 0 ? fileIdSegment.slice(0, dotIndex) : fileIdSegment;
    if (!isValidRecordId(id)) {
      return null;
    }
    if (isMediaExcluded(ext ? `file.${ext}` : '', '') || isMediaExcluded(cleanDisplayName)) {
      return null;
    }

    return {
      kind: 'record',
      collection: collectionName,
      id,
      displayName: cleanDisplayName || undefined,
    };
  }

  // 2) File Manager API getFile: <apiBase>/:collection:getFile/:id
  const apiPrefix = `${appContext.apiBasePath}/`;
  if (parsed.pathname.startsWith(apiPrefix)) {
    const rest = parsed.pathname.slice(apiPrefix.length);
    const getFileMatch = rest.match(/^([^/:]+):getFile\/([^/]+)$/);
    if (getFileMatch) {
      let collectionName: string;
      let id: string;
      try {
        collectionName = decodeURIComponent(getFileMatch[1]);
        id = decodeURIComponent(getFileMatch[2]);
      } catch {
        return null;
      }
      const queryApp = parsed.searchParams.get('__appName') || parsed.searchParams.get('appName');
      const queryDs = parsed.searchParams.get('dataSource') || parsed.searchParams.get('dataSourceKey');
      if (queryApp && queryApp !== appContext.appName) return null;
      if (queryDs && queryDs !== 'main') return null;
      if (!isSupportedCollection(collectionName) || !isValidRecordId(id)) return null;
      if (isMediaExcluded(cleanDisplayName)) return null;

      return {
        kind: 'record',
        collection: collectionName,
        id,
        displayName: cleanDisplayName || undefined,
      };
    }

    // 3) attachments:stream?filterByTk=:id[&collection=attachments|aiFiles]
    if (rest === 'attachments:stream') {
      const id = (parsed.searchParams.get('filterByTk') || '').trim();
      const collection = (parsed.searchParams.get('collection') || 'attachments').trim();
      if (!isSupportedCollection(collection) || !isValidRecordId(id)) return null;
      if (isMediaExcluded(cleanDisplayName)) return null;
      return {
        kind: 'record',
        collection,
        id,
        displayName: cleanDisplayName || undefined,
      };
    }

    // 4) filePreviewAuth:streamDocument?collection=:collection&id=:id
    if (rest === 'filePreviewAuth:streamDocument') {
      const id = (parsed.searchParams.get('id') || '').trim();
      const collection = (parsed.searchParams.get('collection') || '').trim();
      if (!isSupportedCollection(collection) || !isValidRecordId(id)) return null;
      if (isMediaExcluded(cleanDisplayName)) return null;
      return {
        kind: 'record',
        collection,
        id,
        displayName: cleanDisplayName || undefined,
      };
    }
  }

  return null;
}

function getAttachmentDisplayName(att: Record<string, unknown>): string {
  const resp = isPlainRecord(att.response)
    ? isPlainRecord(att.response.data)
      ? att.response.data
      : att.response
    : null;
  const filename =
    readString(att, 'filename') || readString(att, 'name') || readString(resp, 'filename') || readString(resp, 'name');
  if (filename) return filename;
  const title = readString(att, 'title') || readString(resp, 'title');
  const extname = readString(att, 'extname') || readString(resp, 'extname');
  if (title && extname) {
    const normalizedExt = extname.startsWith('.') ? extname : `.${extname}`;
    return title.toLowerCase().endsWith(normalizedExt.toLowerCase()) ? title : `${title}${normalizedExt}`;
  }
  return title;
}

function getAttachmentUrls(att: Record<string, unknown>): string[] {
  const resp = isPlainRecord(att.response)
    ? isPlainRecord(att.response.data)
      ? att.response.data
      : att.response
    : null;
  return [
    readString(att, 'url'),
    readString(att, 'preview'),
    readString(att, 'downloadUrl'),
    readString(att, 'path'),
    readString(resp, 'url'),
    readString(resp, 'preview'),
    readString(resp, 'downloadUrl'),
  ].filter(Boolean);
}

function isPendingOrFailedAttachment(att: Record<string, unknown>): boolean {
  const status = readString(att, 'status').toLowerCase();
  return status === 'uploading' || status === 'error' || status === 'removed';
}

export function extractPersistedDocumentSourceFromAttachment(
  attachment: unknown,
  appContext: AppRouteContext,
): DocumentPreviewSource | null {
  if (!isPlainRecord(attachment)) {
    return null;
  }
  if (isPendingOrFailedAttachment(attachment)) {
    return null;
  }

  const resp = isPlainRecord(attachment.response)
    ? isPlainRecord(attachment.response.data)
      ? attachment.response.data
      : attachment.response
    : null;

  const displayName = getAttachmentDisplayName(attachment);
  const mimetype =
    readString(attachment, 'mimetype') ||
    readString(attachment, 'type') ||
    readString(resp, 'mimetype') ||
    readString(resp, 'type');

  if (isMediaExcluded(displayName, mimetype)) {
    return null;
  }

  const rawId = attachment.id ?? resp?.id;
  if (isValidRecordId(rawId)) {
    const rawCollection =
      readString(attachment, 'collectionName') ||
      readString(attachment, 'collection') ||
      readString(resp, 'collectionName') ||
      readString(resp, 'collection') ||
      'aiFiles';
    if (!isSupportedCollection(rawCollection)) {
      return null;
    }
    return {
      kind: 'record',
      collection: rawCollection,
      id: rawId,
      displayName: displayName || undefined,
    };
  }

  for (const candidateUrl of getAttachmentUrls(attachment)) {
    const parsedSkillHub = parseSkillHubDocumentUrl(candidateUrl, appContext, displayName);
    if (parsedSkillHub) return parsedSkillHub;
    const parsedFileManager = parseFileManagerDocumentUrl(candidateUrl, appContext, displayName);
    if (parsedFileManager) return parsedFileManager;
  }

  return null;
}

function getSessionSnapshot(runtime: ChatBoxRuntime): ChatSessionSnapshot {
  try {
    const messagesModel = runtime.chatMessageModel as unknown as ChatMessageModelLike;
    const sessionId = runtime.chatConversationModel?.currentConversation;
    if (typeof messagesModel?.getSessionState === 'function') {
      return messagesModel.getSessionState(sessionId) || {};
    }
    return messagesModel?.sessions?.[sessionId || CHAT_DEFAULT_SESSION_KEY] || {};
  } catch {
    return {};
  }
}

function decodeManifestPayload(raw: string): string {
  let payload = raw.trim();
  if (payload.includes('\\"') && !payload.includes('"')) {
    payload = payload.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return payload;
}

function collectSingleMessageTexts(msg: unknown): string[] {
  const texts: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value) {
      texts.push(value);
    } else if (value && typeof value === 'object') {
      try {
        texts.push(JSON.stringify(value));
      } catch {
        // ignore circular objects
      }
    }
  };

  if (!isPlainRecord(msg)) return texts;
  const content = msg.content ?? msg;
  if (typeof content === 'string') {
    push(content);
  } else if (isPlainRecord(content)) {
    push(content.content);
    if (Array.isArray(content.tool_calls)) {
      for (const tc of content.tool_calls) {
        if (isPlainRecord(tc)) {
          push(tc.content);
        }
      }
    }
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (isPlainRecord(tc)) {
        push(tc.content);
      }
    }
  }
  return texts;
}

export function extractSkillHubManifestEntriesFromMessage(msg: unknown): SkillHubManifestEntry[] {
  const entries: SkillHubManifestEntry[] = [];
  for (const text of collectSingleMessageTexts(msg)) {
    SKILLHUB_MANIFEST_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SKILLHUB_MANIFEST_RE.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(decodeManifestPayload(match[1]));
        if (!Array.isArray(parsed)) continue;
        for (const item of parsed) {
          if (isPlainRecord(item) && typeof item.name === 'string' && typeof item.downloadUrl === 'string') {
            entries.push({
              name: item.name,
              downloadUrl: item.downloadUrl,
              mimetype: typeof item.mimetype === 'string' ? item.mimetype : null,
              size: typeof item.size === 'number' ? item.size : null,
              execId: typeof item.execId === 'string' ? item.execId : null,
            });
          }
        }
      } catch {
        // ignore malformed manifest
      }
    }
  }
  return entries;
}

function flattenSessionMessages(messages: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const msg of messages) {
    result.push(msg);
    if (isPlainRecord(msg) && isPlainRecord(msg.content) && Array.isArray(msg.content.subAgentConversations)) {
      for (const subConv of msg.content.subAgentConversations) {
        if (isPlainRecord(subConv) && Array.isArray(subConv.messages)) {
          result.push(...flattenSessionMessages(subConv.messages));
        }
      }
    }
  }
  return result;
}

function getMessageAttachments(msg: unknown): unknown[] {
  if (!isPlainRecord(msg)) return [];
  const list: unknown[] = [];
  if (Array.isArray(msg.attachments)) {
    list.push(...msg.attachments);
  }
  if (isPlainRecord(msg.content) && Array.isArray(msg.content.attachments)) {
    list.push(...msg.content.attachments);
  }
  return list;
}

function getOutermostBubbleInScope(scopeRoot: HTMLElement, target: Element): HTMLElement | null {
  let current: Element | null = target.closest('.ant-bubble');
  let outermost: HTMLElement | null = null;
  while (current && scopeRoot.contains(current)) {
    if (current instanceof HTMLElement) {
      outermost = current;
    }
    current = current.parentElement?.closest('.ant-bubble') || null;
  }
  return outermost;
}

function getTopLevelBubblesInScope(scopeRoot: HTMLElement): HTMLElement[] {
  const allBubbles = Array.from(scopeRoot.querySelectorAll<HTMLElement>('.ant-bubble'));
  return allBubbles.filter((bubble) => {
    const parentBubble = bubble.parentElement?.closest('.ant-bubble');
    return !parentBubble || !scopeRoot.contains(parentBubble);
  });
}

function findOwningMessageForElement(
  scopeRoot: HTMLElement,
  target: Element,
  messages: unknown[],
  matchHint?: { rawHref?: string; filenameCandidates?: string[] },
): unknown | null {
  const flatMessages = flattenSessionMessages(messages);
  if (flatMessages.length === 0) return null;

  // 1) Direct React ref match (UserMessage attaches msg.ref on MessageWrapper)
  for (const msg of flatMessages) {
    if (!isPlainRecord(msg)) continue;
    const content = isPlainRecord(msg.content) ? msg.content : msg;
    const refObj = isPlainRecord(content.ref) ? content.ref : isPlainRecord(msg.ref) ? msg.ref : null;
    const current = refObj?.current;
    if (current instanceof Element && current.contains(target)) {
      return msg;
    }
  }

  // 2) Bubble position match inside the chat scope
  const clickedBubble = getOutermostBubbleInScope(scopeRoot, target);
  if (clickedBubble) {
    const topBubbles = getTopLevelBubblesInScope(scopeRoot);
    const bubbleIndex = topBubbles.indexOf(clickedBubble);

    if (bubbleIndex >= 0 && topBubbles.length === flatMessages.length) {
      return flatMessages[bubbleIndex];
    }

    // When rendered bubbles count differs (e.g. greeting or system dividers), align by nth bubble
    // containing the clicked link/filename against messages containing the same link/filename.
    if (bubbleIndex >= 0 && matchHint) {
      const candidates = (matchHint.filenameCandidates || []).map((c) => c.toLowerCase());
      const rawHref = (matchHint.rawHref || '').trim();
      const matchingBubbles = topBubbles.filter((bubble) => {
        if (rawHref && bubble.querySelector(`a[href="${CSS.escape ? CSS.escape(rawHref) : rawHref}"]`)) {
          return true;
        }
        const text = (bubble.textContent || '').toLowerCase();
        return candidates.some((name) => name && text.includes(name));
      });
      const matchingMessages = flatMessages.filter((msg) => {
        const texts = collectSingleMessageTexts(msg).join('\n').toLowerCase();
        if (rawHref && texts.includes(rawHref.toLowerCase())) {
          return true;
        }
        const manifestEntries = extractSkillHubManifestEntriesFromMessage(msg);
        if (manifestEntries.some((entry) => candidates.includes(entry.name.toLowerCase().trim()))) {
          return true;
        }
        const atts = getMessageAttachments(msg);
        if (
          atts.some(
            (att) =>
              isPlainRecord(att) &&
              getDisplayNameCandidates(getAttachmentDisplayName(att)).some((c) => candidates.includes(c.toLowerCase())),
          )
        ) {
          return true;
        }
        return false;
      });

      const occurrenceIdx = matchingBubbles.indexOf(clickedBubble);
      if (occurrenceIdx >= 0 && matchingBubbles.length === matchingMessages.length) {
        return matchingMessages[occurrenceIdx];
      }
    }
  }

  return null;
}

function isRelativeSkillHubLink(rawHref: string): boolean {
  return /^(?:sandbox:(?:\/\/)?|\/?download\/)/i.test(rawHref.trim());
}

function resolveFromManifestEntries(
  entries: SkillHubManifestEntry[],
  nameCandidates: string[],
  appContext: AppRouteContext,
  displayName?: string,
): DocumentPreviewSource | null {
  const normalizedCandidates = new Set(nameCandidates.map((c) => c.toLowerCase().trim()).filter(Boolean));
  const matchedEntries = entries.filter((entry) => normalizedCandidates.has(entry.name.toLowerCase().trim()));
  if (matchedEntries.length === 0) return null;

  const uniqueSources = new Map<string, DocumentPreviewSource>();
  for (const entry of matchedEntries) {
    const parsed = parseSkillHubDocumentUrl(entry.downloadUrl, appContext, displayName || entry.name);
    if (parsed && parsed.kind === 'skillHub') {
      uniqueSources.set(`${parsed.execId}:${parsed.filename}`, parsed);
    } else if (entry.execId && entry.name && !isMediaExcluded(entry.name, entry.mimetype || '')) {
      uniqueSources.set(`${entry.execId}:${entry.name}`, {
        kind: 'skillHub',
        execId: entry.execId,
        filename: entry.name,
        displayName: displayName || entry.name,
      });
    }
  }

  if (uniqueSources.size === 1) {
    return Array.from(uniqueSources.values())[0];
  }
  return null;
}

function normalizeUrlForCompare(raw: string, origin: string): string {
  if (!raw) return '';
  try {
    const parsed = new URL(raw, origin);
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return raw.trim();
  }
}

function getSourceDedupKey(source: DocumentPreviewSource): string {
  if (source.kind === 'record') {
    return `record:${source.collection}:${String(source.id)}`;
  }
  return `skillHub:${source.execId}:${source.filename}`;
}

function resolveAttachmentFromPool(
  pool: unknown[],
  rawHref: string,
  label: string,
  appContext: AppRouteContext,
): DocumentPreviewSource | null {
  const normalizedHref = rawHref ? normalizeUrlForCompare(rawHref, appContext.origin) : '';

  if (normalizedHref) {
    const matchedByUrl = pool.filter((item) => {
      if (!isPlainRecord(item)) return false;
      return getAttachmentUrls(item).some((u) => normalizeUrlForCompare(u, appContext.origin) === normalizedHref);
    });
    if (matchedByUrl.length > 0) {
      const unique = new Map<string, DocumentPreviewSource>();
      for (const att of matchedByUrl) {
        const source = extractPersistedDocumentSourceFromAttachment(att, appContext);
        if (source) {
          unique.set(getSourceDedupKey(source), source);
        }
      }
      return unique.size === 1 ? Array.from(unique.values())[0] : null;
    }
    // When an explicit href/URL is present and does not match any attachment URL, do not guess by filename.
    return null;
  }

  const labelCandidates = new Set(
    getDisplayNameCandidates(label)
      .map((c) => c.toLowerCase().trim())
      .filter(Boolean),
  );
  if (labelCandidates.size === 0) return null;

  const matchedByName = pool.filter((item) => {
    if (!isPlainRecord(item)) return false;
    const itemName = getAttachmentDisplayName(item);
    if (!itemName) return false;
    return getDisplayNameCandidates(itemName).some((c) => labelCandidates.has(c.toLowerCase().trim()));
  });

  if (matchedByName.length === 0) return null;

  // If any matched item in this narrowed pool is still uploading/errored and none are persisted, do not intercept.
  const unique = new Map<string, DocumentPreviewSource>();
  for (const att of matchedByName) {
    const source = extractPersistedDocumentSourceFromAttachment(att, appContext);
    if (source) {
      unique.set(getSourceDedupKey(source), source);
    }
  }

  // Never guess when multiple distinct persisted records share the same display filename.
  return unique.size === 1 ? Array.from(unique.values())[0] : null;
}

export function getDisplayNameFromCardElement(cardEl: HTMLElement): string {
  if (cardEl.tagName === 'A') return cardEl.textContent?.trim() || '';

  const nameEl = cardEl.querySelector('[class*="-name"]');
  if (nameEl?.textContent) return nameEl.textContent.trim();

  const anchors = cardEl.querySelectorAll('a');
  for (let i = 0; i < anchors.length; i += 1) {
    const text = anchors[i].textContent?.trim();
    if (text) return text;
  }

  const prefixEl = cardEl.querySelector('[class*="ellipsis-prefix"]');
  const suffixEl = cardEl.querySelector('[class*="ellipsis-suffix"]');
  if (prefixEl && suffixEl) {
    return `${prefixEl.textContent || ''}${suffixEl.textContent || ''}`.trim();
  }

  return cardEl.textContent?.trim() || '';
}

export interface ClickableChatFileTarget {
  anchor: HTMLAnchorElement | null;
  card: HTMLElement | null;
  tag: HTMLElement | null;
  rawHref: string;
  label: string;
}

export function findClickableChatFileTarget(scopeRoot: HTMLElement, target: Element): ClickableChatFileTarget | null {
  if (target.closest('button, [class*="-remove"], .ant-tag-close-icon, .ant-btn')) {
    return null;
  }
  if (target.closest('img, video, .ant-image')) {
    return null;
  }

  const anchor = target.closest('a[href]') as HTMLAnchorElement | null;
  const card = target.closest(
    '.ant-attachment-list-card, .ant-upload-list-item, [data-ai-chat-file-preview-card]',
  ) as HTMLElement | null;
  const tag = target.closest('.ant-tag') as HTMLElement | null;

  if (!anchor && !card && !tag) {
    return null;
  }
  if (
    (anchor && !scopeRoot.contains(anchor)) ||
    (card && !scopeRoot.contains(card)) ||
    (tag && !scopeRoot.contains(tag))
  ) {
    return null;
  }

  const rawHref =
    anchor?.getAttribute('href') ||
    card?.querySelector<HTMLAnchorElement>('a[href]')?.getAttribute('href') ||
    card?.dataset.fileUrl ||
    '';

  const label = card
    ? getDisplayNameFromCardElement(card)
    : anchor
      ? anchor.textContent?.trim() || ''
      : tag?.textContent?.trim() || '';

  return { anchor, card, tag, rawHref, label };
}

export function resolveDocumentSourceForElement(
  app: ChatPreviewAppLike,
  scope: ChatScope,
  target: Element,
): DocumentPreviewSource | null {
  const clickable = findClickableChatFileTarget(scope.root, target);
  if (!clickable) {
    return null;
  }

  const { rawHref, label, card, anchor } = clickable;
  if (isMediaExcluded(label, '', target)) {
    return null;
  }

  const appContext = getAppRouteContext(app);

  // 1) Direct Skill Hub link preserves the exact execId from the clicked link (supports `f` and `filename`).
  if (rawHref) {
    const directSkillHub = parseSkillHubDocumentUrl(rawHref, appContext, label);
    if (directSkillHub) {
      return directSkillHub;
    }

    // 2) Direct File Manager link validated against current app, main data source, and supported collection.
    const directFileManager = parseFileManagerDocumentUrl(rawHref, appContext, label);
    if (directFileManager) {
      return directFileManager;
    }
  }

  const session = getSessionSnapshot(scope.runtime);
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const sessionAttachments = Array.isArray(session.attachments) ? session.attachments : [];
  const senderAttachments = Array.isArray(scope.runtime.chatSenderModel?.attachments)
    ? scope.runtime.chatSenderModel.attachments
    : [];

  const pathFilename = rawHref
    ? stripFilenameNoise(
        rawHref
          .replace(/^sandbox:(?:\/\/)?/i, '')
          .split('?')[0]
          .split('#')[0]
          .split('/')
          .pop() || '',
      )
    : '';
  const nameCandidates = Array.from(
    new Set([...getDisplayNameCandidates(label), ...(pathFilename ? getDisplayNameCandidates(pathFilename) : [])]),
  );

  const owningMessage = findOwningMessageForElement(scope.root, target, messages, {
    rawHref,
    filenameCandidates: nameCandidates,
  });

  // 3) Broken/relative Skill Hub link (`sandbox:download/...` or `/download/...`):
  //    ONLY recover from the owning message's own Skill Hub tool manifest!
  if (anchor && rawHref && isRelativeSkillHubLink(rawHref)) {
    if (owningMessage) {
      const msgEntries = extractSkillHubManifestEntriesFromMessage(owningMessage);
      return resolveFromManifestEntries(msgEntries, nameCandidates, appContext, label || pathFilename);
    }

    // Flat DOM fallback (no .ant-bubble wrapper): allow ONLY when strictly one message in the conversation
    // has a matching manifest entry for this filename; never guess across multiple runs.
    const clickedBubble = getOutermostBubbleInScope(scope.root, target);
    if (!clickedBubble) {
      const allEntries = flattenSessionMessages(messages).flatMap((m) => extractSkillHubManifestEntriesFromMessage(m));
      return resolveFromManifestEntries(allEntries, nameCandidates, appContext, label || pathFilename);
    }

    return null;
  }

  // External or unknown anchor links that are not cards must NOT be intercepted.
  if (anchor && !card && rawHref) {
    const parsed = parseSameOriginUrl(rawHref, appContext.origin);
    if (!parsed) {
      return null;
    }
  }

  // 4) Uploaded chat attachment card / tag / message attachment backed by persisted server record.
  const isInSender = Boolean(target.closest('.ant-sender'));
  let attachmentPool: unknown[];
  if (isInSender) {
    attachmentPool = [...sessionAttachments, ...senderAttachments];
  } else if (owningMessage) {
    attachmentPool = getMessageAttachments(owningMessage);
  } else {
    attachmentPool = [
      ...sessionAttachments,
      ...senderAttachments,
      ...flattenSessionMessages(messages).flatMap((m) => getMessageAttachments(m)),
    ];
  }

  const fromAttachment = resolveAttachmentFromPool(attachmentPool, rawHref, label, appContext);
  if (fromAttachment) {
    return fromAttachment;
  }

  // If clicked inside an owning message card with no attachment record, allow message-scoped manifest match.
  if (card && owningMessage) {
    const msgEntries = extractSkillHubManifestEntriesFromMessage(owningMessage);
    const fromManifest = resolveFromManifestEntries(msgEntries, nameCandidates, appContext, label);
    if (fromManifest) {
      return fromManifest;
    }
  }

  return null;
}

export function getDocumentPreviewPlugin(app?: ChatPreviewAppLike): DocumentPreviewPluginLike | null {
  const pm = app?.pm;
  if (!pm || typeof pm.get !== 'function') {
    return null;
  }
  const plugin = (pm.get('plugin-file-preview-auth') || pm.get('file-preview-auth')) as
    | DocumentPreviewPluginLike
    | undefined;
  if (plugin && typeof plugin.openDocumentPreview === 'function') {
    return plugin;
  }
  return null;
}

export function openChatDocumentPreview(
  app: ChatPreviewAppLike,
  source: DocumentPreviewSource,
  onUnavailable: () => void,
): boolean {
  const previewPlugin = getDocumentPreviewPlugin(app);
  if (!previewPlugin?.openDocumentPreview) {
    onUnavailable();
    return false;
  }
  previewPlugin.openDocumentPreview(source);
  return true;
}
