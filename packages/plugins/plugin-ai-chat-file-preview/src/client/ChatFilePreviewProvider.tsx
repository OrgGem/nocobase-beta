/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAPIClient, attachmentFileTypes } from '@nocobase/client';
import { useChatMessagesStore, useChatConversationsStore } from '@nocobase/plugin-ai/client';
import { Modal, Button } from 'antd';

type ChatPreviewStoreState = {
  messages?: any[];
  attachments?: any[];
  sessions?: Record<string, { messages?: any[]; attachments?: any[] } | undefined>;
  getSessionState?: (sessionId?: string) => { messages?: any[]; attachments?: any[] };
};

type ChatMessagesStoreArrayHook = (selector: (state: ChatPreviewStoreState) => any[]) => any[];

const CHAT_DEFAULT_SESSION_KEY = '__draft__';
const EMPTY_MESSAGES: any[] = [];
const EMPTY_ATTACHMENTS: any[] = [];

// Ant Design X 1.1.0 prefixes: sender -> ant-sender, bubble -> ant-bubble, attachment -> ant-attachment.
const AI_CHAT_CONTAINER_SELECTOR = '.ant-sender, .ant-attachment, .ant-bubble';
const AI_CHAT_SENDER_SELECTOR = '.ant-sender, .ant-attachment';

function pickSessionState(state: ChatPreviewStoreState, sessionId?: string) {
  const sessions = state.sessions;
  if (!sessions) return null;

  const sessionKey = sessionId || CHAT_DEFAULT_SESSION_KEY;
  const selectedSession = sessions[sessionKey];
  if (selectedSession) return selectedSession;

  return (
    Object.values(sessions).find(
      (session) => (session?.messages?.length || 0) > 0 || (session?.attachments?.length || 0) > 0,
    ) || null
  );
}

export function selectChatMessages(state: ChatPreviewStoreState, sessionId?: string) {
  const session = pickSessionState(state, sessionId);
  if (Array.isArray(session?.messages)) return session.messages;
  return Array.isArray(state.messages) ? state.messages : EMPTY_MESSAGES;
}

export function selectChatAttachments(state: ChatPreviewStoreState, sessionId?: string) {
  const session = pickSessionState(state, sessionId);
  if (Array.isArray(session?.attachments)) return session.attachments;
  return Array.isArray(state.attachments) ? state.attachments : EMPTY_ATTACHMENTS;
}

export interface PreviewFile {
  id?: string | number;
  uid?: string;
  url?: string;
  preview?: string;
  filename?: string;
  name?: string;
  title?: string;
  extname?: string;
  mimetype?: string;
  size?: number;
  path?: string;
  storageId?: string | number;
  storage_id?: string | number;
  storageType?: string;
  storageName?: string;
  storage?: {
    id?: string | number;
    type?: string;
    name?: string;
    [key: string]: any;
  };
  collectionName?: string;
  [key: string]: any;
}

// ─── Inline Fallback Previewer ───────────────────────────────────────────
// Hand-crafted fallback so if plugin-file-preview-auth is disabled or unavaliable,
// the AI chat still gets a 90% wide modal rather than doing nothing.

function FallbackModalPreviewer({ index, list, onSwitchIndex }: any) {
  const file = list?.[index];

  if (!file) return null;

  const url = typeof file === 'string' ? file : file?.url;
  const resolvedUrl =
    url && (url.startsWith('https://') || url.startsWith('http://'))
      ? url
      : `${window.location.origin}/${(url || '').replace(/^\//, '')}`;

  return (
    <Modal
      open={index != null}
      title={file?.title || file?.filename || file?.name || 'File Preview (Fallback)'}
      onCancel={() => onSwitchIndex(null)}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={() => window.open(resolvedUrl, '_blank')}>Open Default</Button>
          <Button onClick={() => onSwitchIndex(null)}>Close</Button>
        </div>
      }
      width="90%"
      centered
    >
      <div
        style={{
          width: '100%',
          height: '70vh',
          background: 'white',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <iframe src={resolvedUrl} style={{ width: '100%', height: '100%', border: 'none', flex: 1 }} />
      </div>
    </Modal>
  );
}

// Define a reliable, context-isolated module-level RAM cache independent of the window object
export const AppRamCache = new Map<string, File | Blob>();

const FILE_EXTENSIONS = [
  'doc',
  'docx',
  'xls',
  'xlsx',
  'pdf',
  'csv',
  'txt',
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
  'svg',
];

const FILENAME_IN_TEXT_RE = new RegExp(
  `[^\\s"'<>()[\\]{}]+\\.(${FILE_EXTENSIONS.join('|')})(?=$|[\\s"'<>()[\\]{},.;:!?])`,
  'gi',
);

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
  return (
    !!url &&
    (url.includes('/api/attachments/') ||
      url.includes('/api/files/download/') ||
      url.includes('/api/worker-monitor/') ||
      url.includes('/api/skillHub:download') ||
      url.includes('/storage/uploads/') ||
      url.includes('amazonaws.com'))
  );
}

/**
 * Extract displayed filename from a FileListCard DOM element.
 */
function getDisplayNameFromCard(cardEl: HTMLElement): string {
  if (cardEl.tagName === 'A') return cardEl.textContent?.trim() || '';

  // 1. Try antd generic filename classes
  const nameEl = cardEl.querySelector('[class*="-name"]') as HTMLElement;
  if (nameEl?.textContent) return nameEl.textContent.trim();

  // 2. Try link elements
  const aNodes = cardEl.querySelectorAll('a');
  for (let i = 0; i < aNodes.length; i++) {
    const text = aNodes[i].textContent?.trim();
    if (text) return text;
  }

  // 3. Try ellipsis splits
  const prefixEl = cardEl.querySelector('[class*="ellipsis-prefix"]');
  const suffixEl = cardEl.querySelector('[class*="ellipsis-suffix"]');
  if (prefixEl && suffixEl) {
    return (prefixEl.textContent || '') + (suffixEl.textContent || '');
  }

  // 4. Last resort (will likely contain file size text like 100KB)
  return cardEl.textContent?.trim() || '';
}

function attToPreviewFile(att: any): PreviewFile {
  return {
    id: att.id,
    uid: att.uid,
    url: att.url,
    preview: att.preview,
    filename: att.filename || att.name,
    name: att.name || att.filename,
    title: att.title,
    extname: att.extname,
    mimetype: att.mimetype,
    size: att.size,
    path: att.path,
    storageId: att.storageId || att.storage_id || att.storage?.id,
    storage_id: att.storage_id,
    storageType: att.storageType || att.storage?.type,
    storageName: att.storageName || att.storage?.name,
    storage: att.storage,
    collectionName: att.collectionName || 'aiFiles',
  };
}

export interface SkillHubManifestEntry {
  name: string;
  downloadUrl: string;
  mimetype?: string | null;
  size?: number | null;
  execId?: string | null;
}

const SKILLHUB_MANIFEST_RE = /<!--skillhub:files\s+([\s\S]*?)-->/g;

/**
 * Collect every text fragment from a message that may carry a skillhub manifest.
 * Tool results live under content.tool_calls[].content and are produced by the
 * server, so the embedded manifest is trustworthy regardless of how the LLM
 * rewrote the visible markdown links.
 */
function collectMessageTexts(msg: any): string[] {
  const texts: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value) {
      texts.push(value);
    } else if (value && typeof value === 'object') {
      texts.push(JSON.stringify(value));
    }
  };

  if (!msg) return texts;
  const content = msg.content ?? msg;
  push(typeof content === 'string' ? content : content?.content);

  const toolCalls = content?.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      push(tc?.content);
    }
  }
  return texts;
}

function decodeManifestPayload(raw: string): string {
  let payload = raw.trim();
  // When the manifest is read from a JSON.stringify'd object, quotes are escaped.
  if (payload.includes('\\"') && !payload.includes('"')) {
    payload = payload.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return payload;
}

/**
 * Build filename -> manifest entry map from all skillhub manifests in the conversation.
 * Later entries win so the most recent execution's URL is preferred.
 */
export function buildSkillHubManifestMap(messages: any[]): Map<string, SkillHubManifestEntry> {
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

/**
 * Resolve a manifest entry for a displayed filename, trying exact and normalized names.
 */
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

export function findSkillHubUrlForFile(filename: string, messages: any[]): string | null {
  if (!filename) return null;
  const cleanFilename = filename.toLowerCase().trim();

  for (const msg of messages) {
    if (!msg?.content) continue;
    const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    const regex = /\/api\/skillHub:download\?[^)\s"']+/g;
    const matches = contentStr.match(regex);
    if (matches) {
      for (const match of matches) {
        try {
          const cleanMatch = match.replace(/&amp;/g, '&');
          const url = new URL(cleanMatch, window.location.origin);
          const f = url.searchParams.get('f');
          const fn = url.searchParams.get('filename') || url.searchParams.get('name');

          let decodedName = '';
          if (f) {
            try {
              let base64 = f.replace(/-/g, '+').replace(/_/g, '/');
              while (base64.length % 4) {
                base64 += '=';
              }
              decodedName = atob(base64);
            } catch {
              // ignore
            }
          } else if (fn) {
            decodedName = decodeURIComponent(fn);
          }

          if (decodedName && decodedName.toLowerCase().trim() === cleanFilename) {
            return cleanMatch;
          }
        } catch {
          // ignore
        }
      }
    }
  }
  return null;
}

export function findLatestExecId(messages: any[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg?.content) continue;
    const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    const match = contentStr.match(/execId=([a-zA-Z0-9_-]+)/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export function resolveDownloadUrl(urlOrPath: string, messages: any[]): string {
  if (!urlOrPath) return urlOrPath;

  if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
    return urlOrPath;
  }

  const cleanPath = urlOrPath.replace(/^sandbox:(?:\/\/)?/, '');

  if (cleanPath.startsWith('api/')) {
    return '/' + cleanPath;
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
    const matchedUrl = findSkillHubUrlForFile(filename, messages);
    if (matchedUrl) {
      return matchedUrl;
    }
    const latestExecId = findLatestExecId(messages);
    if (latestExecId) {
      return `/api/skillHub:download?execId=${latestExecId}&filename=${encodeURIComponent(filename)}`;
    }
    return '/download/' + filename;
  }

  if (!cleanPath.startsWith('/') && !cleanPath.includes(':')) {
    return '/' + cleanPath;
  }

  return cleanPath;
}

export function rewriteMarkdownContent(content: string, messages: any[]): string {
  if (typeof content !== 'string') return content;

  // Match: sandbox:download/, sandbox://download/, download/, /download/ with optional sandbox prefix
  let nextContent = content.replace(/\]\(((?:sandbox:(?:\/\/)?|\/?download\/)[^)]+)\)/g, (match, p1) => {
    const resolved = resolveDownloadUrl(p1, messages);
    return `](${resolved})`;
  });

  nextContent = nextContent.replace(/href=["']((?:sandbox:(?:\/\/)?|\/?download\/)[^"']+)["']/g, (match, p1) => {
    const resolved = resolveDownloadUrl(p1, messages);
    return `href="${resolved}"`;
  });

  return nextContent;
}

/**
 * Find file metadata matching the displayed filename across all message attachments.
 */
function findFileByDisplayName(displayName: string, messages: any[], pendingAttachments: any[]): PreviewFile | null {
  if (!displayName) return null;
  const displayNames = getDisplayNameCandidates(displayName);

  // Search sent messages
  for (const msg of messages) {
    const content = msg.content || msg;
    const attachments = content?.attachments;
    if (!attachments?.length) continue;

    for (const att of attachments) {
      const attName = att.filename || att.name || '';
      const attTitleExt = `${att.title || ''}${att.extname || ''}`;
      if (displayNames.includes(attName) || displayNames.includes(attTitleExt)) {
        return attToPreviewFile(att);
      }

      // Relaxed match for NocoBase hashed file names
      for (const name of displayNames) {
        if ((attName && name.includes(attName.replace(/\.[^/.]+$/, ''))) || (att.title && name.includes(att.title))) {
          return attToPreviewFile(att);
        }
      }
    }
  }

  // Search pending (not yet sent) attachments
  for (const att of pendingAttachments || []) {
    const attName = att.filename || att.name || '';
    const attTitleExt = `${att.title || ''}${att.extname || ''}`;
    if (displayNames.includes(attName) || displayNames.includes(attTitleExt)) {
      return attToPreviewFile(att);
    }

    // Relaxed match for NocoBase hashed file names (e.g. report.docx-c2ywti.docx)
    for (const name of displayNames) {
      if ((attName && name.includes(attName.replace(/\.[^/.]+$/, ''))) || (att.title && name.includes(att.title))) {
        return attToPreviewFile(att);
      }
    }
  }

  return null;
}

/**
 * Find file metadata matching the extracted URL
 */
function findFileByUrl(url: string, messages: any[], pendingAttachments: any[]): PreviewFile | null {
  if (!url) return null;
  const matchUrl = (u1: string, u2: string) => {
    if (!u1 || !u2) return false;
    const clean1 = u1.split('?')[0].replace(location.origin, '').replace(/^\//, '');
    const clean2 = u2.split('?')[0].replace(location.origin, '').replace(/^\//, '');
    return clean1 === clean2;
  };
  for (const msg of messages) {
    const content = msg.content || msg;
    const attachments = content?.attachments;
    if (!attachments?.length) continue;
    for (const att of attachments) {
      if (matchUrl(att.url, url) || matchUrl(att.preview, url)) return attToPreviewFile(att);
    }
  }
  for (const att of pendingAttachments || []) {
    if (matchUrl(att.url, url) || matchUrl(att.preview, url)) return attToPreviewFile(att);
  }
  return null;
}

/**
 * Inner component that reads from plugin-ai's zustand stores via hooks.
 * Uses refs to make latest state available inside the DOM click handler.
 */
const ChatFilePreviewInner: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<PreviewFile | null>(null);
  const apiClient = useAPIClient();

  const currentConversation = useChatConversationsStore.use.currentConversation();
  const activeSessionId = currentConversation || '';

  // NocoBase 2.1 moved chat messages into per-session store state.
  const chatStore = useChatMessagesStore as unknown as ChatMessagesStoreArrayHook;
  const selectMessagesForSession = useCallback(
    (state: ChatPreviewStoreState) => selectChatMessages(state, activeSessionId),
    [activeSessionId],
  );
  const selectAttachmentsForSession = useCallback(
    (state: ChatPreviewStoreState) => selectChatAttachments(state, activeSessionId),
    [activeSessionId],
  );
  const messages = chatStore(selectMessagesForSession);
  const pendingAttachments = chatStore(selectAttachmentsForSession);

  // Keep latest values in refs for the click handler (avoids stale closures)
  const messagesRef = useRef(messages);
  const pendingAttachmentsRef = useRef(pendingAttachments);
  messagesRef.current = messages;
  pendingAttachmentsRef.current = pendingAttachments;

  const token = apiClient.auth?.token || '';

  // Track global drop and input change events to intercept file object selection ONLY for AI chat
  useEffect(() => {
    // Modify href attributes of native NocoBase file links and images in chat to use the proxy and append the token
    const rewriteObtrusiveLinks = () => {
      const appendToken = (url: string) => {
        if (!token) return url;
        if (url.includes('token=')) return url;
        return url + (url.includes('?') ? '&' : '?') + `token=${token}`;
      };

      const links = document.querySelectorAll<HTMLAnchorElement>('a[href*="/api/attachments"]');
      links.forEach((link) => {
        const href = link.getAttribute('href');
        if (href && !href.includes('/api/filePreviewAuth:download')) {
          link.setAttribute('href', appendToken(`/api/filePreviewAuth:download?url=${encodeURIComponent(href)}`));
        }
      });

      // Also rewrite ai-attachment-link anchors
      const aiLinks = document.querySelectorAll<HTMLAnchorElement>('a.ai-attachment-link');
      aiLinks.forEach((link) => {
        const href = link.getAttribute('href');
        if (
          href &&
          !href.includes('/api/filePreviewAuth:download') &&
          !href.includes('skillHub:download') &&
          !href.includes('worker-monitor')
        ) {
          link.setAttribute('href', appendToken(`/api/filePreviewAuth:download?url=${encodeURIComponent(href)}`));
        }
      });

      // Also rewrite image tags so thumbnails don't 404
      const imgs = document.querySelectorAll<HTMLImageElement>('img[src*="/api/attachments"]');
      imgs.forEach((img) => {
        const src = img.getAttribute('src');
        if (src && !src.includes('/api/filePreviewAuth:download')) {
          img.setAttribute('src', appendToken(`/api/filePreviewAuth:download?url=${encodeURIComponent(src)}`));
        }
      });

      // Auto-style raw markdown links for Skill Hub and Worker Monitor as interactive file attachments
      const rawFileLinks = document.querySelectorAll<HTMLAnchorElement>(
        '.ant-bubble a[href*="skillHub:download"], .ant-bubble a[href*="worker-monitor"]',
      );
      rawFileLinks.forEach((link) => {
        if (!link.classList.contains('ai-attachment-link')) {
          link.classList.add('ai-attachment-link');
        }
      });
    };

    // Run periodically to catch newly rendered chat messages
    const timer = setInterval(rewriteObtrusiveLinks, 1000);
    return () => clearInterval(timer);
  }, [token]);

  useEffect(() => {
    const handleDrop = (e: DragEvent) => {
      const target = e.target as HTMLElement;
      if (!target || !target.closest) return;
      if (!target.closest(AI_CHAT_SENDER_SELECTOR)) return;

      if (e.dataTransfer?.files) {
        Array.from(e.dataTransfer.files).forEach((f) => {
          if (f.name) {
            AppRamCache.set(f.name, f);
          }
        });
      }
    };

    const handleChange = (e: Event) => {
      const target = e.target as HTMLInputElement;
      if (!target || !target.closest) return;
      if (!target.closest(AI_CHAT_SENDER_SELECTOR)) return;

      if (target?.type === 'file' && target.files) {
        Array.from(target.files).forEach((f) => {
          if (f.name) {
            AppRamCache.set(f.name, f);
          }
        });
      }
    };

    window.addEventListener('drop', handleDrop, true);
    document.addEventListener('change', handleChange, true);
    return () => {
      window.removeEventListener('drop', handleDrop, true);
      document.removeEventListener('change', handleChange, true);
    };
  }, []);

  // Intercept antd upload origin files via Zustand state store as duplicate safety net
  useEffect(() => {
    if (!pendingAttachmentsRef.current?.length) return;
    pendingAttachmentsRef.current.forEach((att: any) => {
      const fileObj = att.originFileObj || att;
      if (fileObj && (fileObj instanceof Blob || fileObj instanceof File || 'size' in fileObj)) {
        const name = att.name || att.filename || fileObj.name;
        if (name) {
          AppRamCache.set(name, fileObj);
        }
      }
    });
  }, [pendingAttachments]);

  // Rewrite sandbox: and relative download/ links in messages to clean absolute routes so rehypeSanitize doesn't strip them and links function correctly
  useEffect(() => {
    if (!messages?.length) return;
    messages.forEach((msg) => {
      if (!msg) return;
      if (typeof msg.content === 'string') {
        const nextContent = rewriteMarkdownContent(msg.content, messages);
        if (nextContent !== msg.content) {
          msg.content = nextContent;
        }
      } else if (msg.content && typeof msg.content === 'object' && typeof msg.content.content === 'string') {
        const nextContent = rewriteMarkdownContent(msg.content.content, messages);
        if (nextContent !== msg.content.content) {
          msg.content.content = nextContent;
        }
      }
    });
  }, [messages]);

  // Periodically check pure RAM cache and ONLY mark DOM cards that physically exist in local JS memory.
  // This automatically rules out external database checks and prevents 403s on old un-cached files.
  useEffect(() => {
    const checkInterval = setInterval(() => {
      // Isolate strictly to AI module components! (AI Chat outputs Ant Design X attachments)
      const aiContainers = document.querySelectorAll(AI_CHAT_CONTAINER_SELECTOR);

      const cards: Element[] = [];
      aiContainers.forEach((container) => {
        container
          .querySelectorAll('div[class*="attachment-list-card"]:not([class*="attachment-list-card-"])')
          .forEach((c) => cards.push(c));
        container.querySelectorAll('a').forEach((a) => {
          const href = (a as HTMLAnchorElement).href;
          if (
            href &&
            (href.includes('/api/attachments/') ||
              href.includes('/api/files/download/') ||
              href.includes('/api/worker-monitor/') ||
              href.includes('/api/skillHub:download'))
          ) {
            cards.push(a);
            if (!a.classList.contains('ai-attachment-link')) {
              a.classList.add('ai-attachment-link');
              a.classList.add('attachment-list-card'); // Trick click interceptor
            }
          }
        });
      });

      cards.forEach((card) => {
        const el = card as HTMLElement;
        const displayName = getDisplayNameFromCard(el);
        let fallbackUrl = '';
        if (el.tagName === 'A') {
          fallbackUrl = (el as HTMLAnchorElement).href;
        } else {
          const urlNodes = el.querySelectorAll('a');
          urlNodes.forEach((node) => {
            if (node.href) fallbackUrl = node.href;
          });
        }

        // Resolve real file name from data store
        const file =
          findFileByDisplayName(displayName, messagesRef.current, pendingAttachmentsRef.current) ||
          findFileByUrl(fallbackUrl, messagesRef.current, pendingAttachmentsRef.current);
        const realName = file?.filename || file?.name || file?.title;
        const normalizedDisplayName = extractFilenameFromText(displayName);

        // Strict RAM cache check
        const cacheHitName =
          realName && AppRamCache.has(realName)
            ? realName
            : displayName && AppRamCache.has(displayName)
              ? displayName
              : normalizedDisplayName && AppRamCache.has(normalizedDisplayName)
                ? normalizedDisplayName
                : null;

        const isAIGenerated = isKnownFileUrl(fallbackUrl);

        // Manifest match marks a card previewable even when the LLM wrote a broken download/ link.
        const manifestMap = buildSkillHubManifestMap(messagesRef.current);
        const hasManifestEntry =
          !!findManifestEntryForName(displayName, manifestMap) ||
          !!findManifestEntryForName(normalizedDisplayName, manifestMap);

        if (file || cacheHitName || isAIGenerated || hasManifestEntry) {
          el.classList.add('is-cached-previewable');
        } else {
          el.classList.remove('is-cached-previewable');
        }
      });
    }, 1000);
    return () => clearInterval(checkInterval);
  }, []);

  // Inject global CSS for explicit UI and native z-index click interception for child texts/tags
  useEffect(() => {
    const style = document.createElement('style');
    style.innerHTML = `
      .ant-attachment-list-card {
        position: relative !important;
        cursor: pointer !important;
      }
      /* Prevent pointer events on inner text and icons so the outer div receives the absolute click */
      .ant-attachment-list-card a,
      .ant-attachment-list-card [class*="-icon"],
      .ant-attachment-list-card span {
        pointer-events: none !important;
      }
      /* Re-enable pointer events for the delete button specifically */
      .ant-attachment-list-card [class*="-remove"],
      .ant-attachment-list-card button,
      .ant-attachment-list-card .ant-btn {
        pointer-events: auto !important;
      }
      /* Visual "Preview" badge at the top-left corner using proper SVG */
      .ant-attachment-list-card.is-cached-previewable::after {
        content: '';
        background-image: url("data:image/svg+xml,%3Csvg viewBox='64 64 896 896' xmlns='http://www.w3.org/2000/svg' fill='rgba(0,0,0,0.65)'%3E%3Cpath d='M942.2 486.2C847.4 286.5 704.1 186 512 186c-192.2 0-335.4 100.5-430.2 300.3a60.3 60.3 0 000 51.5C176.6 737.5 319.9 838 512 838c192.2 0 335.4-100.5 430.2-300.3 7.7-16.2 7.7-35 0-51.5zM512 766c-161.3 0-279.4-81.8-362.7-254C232.6 339.8 350.7 258 512 258c161.3 0 279.4 81.8 362.7 254C791.5 684.2 673.4 766 512 766zm-4-430c-97.2 0-176 78.8-176 176s78.8 176 176 176 176-78.8 176-176-78.8-176-176-176zm0 288c-61.9 0-112-50.1-112-112s50.1-112 112-112 112 50.1 112 112-50.1 112-112 112z'/%3E%3C/svg%3E");
        background-size: contain;
        background-repeat: no-repeat;
        position: absolute;
        top: 6px;
        left: 6px;
        width: 14px;
        height: 14px;
        z-index: 10;
        pointer-events: none;
      }
      /* Hide native antd thumbnail icon if we placed an eye so it doesnt look messy */
      .ant-attachment-list-card.is-cached-previewable .ant-upload-list-item-thumbnail {
        opacity: 0.2;
      }
      /* Custom aesthetics for raw AI-generated links to match cards */
      a.ai-attachment-link {
        display: inline-flex;
        align-items: center;
        padding: 8px 12px;
        margin: 4px;
        border: 1px solid #d9d9d9;
        border-radius: 8px;
        background: #fafafa;
        color: rgba(0, 0, 0, 0.88);
        text-decoration: none !important;
        position: relative;
        cursor: pointer !important;
        transition: all 0.2s;
        line-height: 1.5;
      }
      a.ai-attachment-link:hover {
        background: #f0f0f0;
      }
      a.ai-attachment-link::before {
        content: '📄 ';
        margin-right: 8px;
        font-size: 14px;
      }
      a.ai-attachment-link.is-cached-previewable::after {
        content: '';
        background-image: url("data:image/svg+xml,%3Csvg viewBox='64 64 896 896' xmlns='http://www.w3.org/2000/svg' fill='rgba(0,0,0,0.65)'%3E%3Cpath d='M942.2 486.2C847.4 286.5 704.1 186 512 186c-192.2 0-335.4 100.5-430.2 300.3a60.3 60.3 0 000 51.5C176.6 737.5 319.9 838 512 838c192.2 0 335.4-100.5 430.2-300.3 7.7-16.2 7.7-35 0-51.5zM512 766c-161.3 0-279.4-81.8-362.7-254C232.6 339.8 350.7 258 512 258c161.3 0 279.4 81.8 362.7 254C791.5 684.2 673.4 766 512 766zm-4-430c-97.2 0-176 78.8-176 176s78.8 176 176 176 176-78.8 176-176-78.8-176-176-176zm0 288c-61.9 0-112-50.1-112-112s50.1-112 112-112 112 50.1 112 112-50.1 112-112 112z'/%3E%3C/svg%3E");
        background-size: contain;
        background-repeat: no-repeat;
        position: absolute;
        top: -6px;
        left: -6px;
        width: 14px;
        height: 14px;
        z-index: 10;
        pointer-events: none;
      }
    `;
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, []);

  // Click interceptor: capture clicks on FileCard elements
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const el = e.target as Element;
      if (!el || typeof el.closest !== 'function') return;

      // Find closest Anchor (A), FileCard, or Ant Tag (from chat input attachments)
      let fallbackUrl = '';
      let displayName = '';

      const anchorNode = el.closest('a');
      const cardEl = el.closest('.ant-attachment-list-card') as HTMLElement;
      const antTagBtn = el.closest('.ant-tag');

      if (!anchorNode && !cardEl && !antTagBtn) return;

      // Skip remove button clicks
      if (el.closest('[class*="-remove"]') || el.closest('.ant-tag-close-icon') || el.closest('.ant-btn')) return;

      if (cardEl) {
        displayName = getDisplayNameFromCard(cardEl);
        if (cardEl.tagName === 'A') {
          fallbackUrl = (cardEl as HTMLAnchorElement).href;
        } else {
          const urlNodes = cardEl.querySelectorAll('a');
          urlNodes.forEach((node) => {
            if (node.href) fallbackUrl = node.href;
          });
        }
      } else if (anchorNode) {
        fallbackUrl = anchorNode.href;
        displayName = anchorNode.textContent || 'download';
      } else if (antTagBtn) {
        displayName = antTagBtn.textContent?.trim() || '';
      }

      // Decode original url if it's already a proxied url
      let originalFallbackUrl = fallbackUrl;
      if (fallbackUrl && fallbackUrl.includes('/api/filePreviewAuth:download?url=')) {
        try {
          const urlObj = new URL(fallbackUrl, window.location.origin);
          originalFallbackUrl = decodeURIComponent(urlObj.searchParams.get('url') || fallbackUrl);
        } catch {
          // ignore
        }
      }

      let file =
        findFileByDisplayName(displayName, messagesRef.current, pendingAttachmentsRef.current) ||
        findFileByUrl(originalFallbackUrl, messagesRef.current, pendingAttachmentsRef.current);

      const normalizedDisplayName = extractFilenameFromText(displayName);

      // Prefer the server-provided skillhub manifest: it carries the real downloadUrl keyed by
      // filename, so a click resolves correctly even when the LLM wrote a broken `download/...` link.
      const manifestMap = buildSkillHubManifestMap(messagesRef.current);
      const manifestEntry =
        findManifestEntryForName(displayName, manifestMap) ||
        findManifestEntryForName(normalizedDisplayName, manifestMap);

      const isAIGenerated = isKnownFileUrl(originalFallbackUrl) || !!manifestEntry;

      // If we clicked a completely unrelated anchor tag in the admin panel and it's not a known file, abort immediately
      if (!file && !isAIGenerated && anchorNode && !cardEl) {
        return;
      }

      if (!file && manifestEntry) {
        const name = manifestEntry.name || normalizedDisplayName || 'attachment';
        const extname = name.match(/\.([a-z0-9]+)$/i)?.[1];
        file = {
          id: manifestEntry.downloadUrl,
          uid: manifestEntry.downloadUrl,
          url: manifestEntry.downloadUrl,
          filename: name,
          name,
          extname: extname ? `.${extname}` : undefined,
          mimetype: manifestEntry.mimetype || '',
          size: manifestEntry.size ?? undefined,
        } as PreviewFile;
      } else if (!file && isAIGenerated) {
        const extname =
          normalizedDisplayName.match(/\.([a-z0-9]+)$/i)?.[1] ||
          originalFallbackUrl.match(/\.([a-z0-9]+)(?:[?#]|$)/i)?.[1];
        file = {
          id: originalFallbackUrl,
          uid: originalFallbackUrl,
          url: originalFallbackUrl,
          filename: normalizedDisplayName || 'attachment',
          name: normalizedDisplayName || 'attachment',
          extname: extname ? `.${extname}` : undefined,
          mimetype: '',
        } as PreviewFile;
      }

      if (!file && !isAIGenerated) return;

      e.preventDefault();
      e.stopPropagation();

      // Convert to secure proxy URL for everything EXCEPT natively secured endpoints that don't belong to the attachments table
      const proxyTargetUrl = file.url || originalFallbackUrl;
      const shouldUseProxy =
        proxyTargetUrl &&
        !proxyTargetUrl.includes('skillHub:download') &&
        !proxyTargetUrl.includes('worker-monitor') &&
        !proxyTargetUrl.includes('filePreviewAuth:download');

      let secureUrl = proxyTargetUrl;
      if (shouldUseProxy) {
        secureUrl = `/api/filePreviewAuth:download?url=${encodeURIComponent(proxyTargetUrl)}`;
        const collectionName = (file as any).collectionName || 'aiFiles';
        const storageId = (file as any).storage_id || (file as any).storageId;

        if (collectionName) {
          secureUrl += `&collection=${encodeURIComponent(collectionName)}`;
        }
        if (storageId) {
          secureUrl += `&storageId=${encodeURIComponent(storageId)}`;
        }
      }

      file = {
        ...file,
        url: secureUrl,
        collectionName: (file as any).collectionName || 'aiFiles',
      };

      setPreviewFile(file);
      setPreviewOpen(true);
    };

    document.addEventListener('click', handler, { capture: true });
    return () => document.removeEventListener('click', handler, { capture: true });
  }, []);

  const handleClose = useCallback(() => {
    setPreviewOpen(false);
    setPreviewFile(null);
  }, []);

  const SystemPreviewer = useMemo(() => {
    if (!previewFile || !previewOpen) return null;
    const type = attachmentFileTypes.getTypeByFile(previewFile);
    return type?.Previewer || FallbackModalPreviewer;
  }, [previewFile, previewOpen]);

  return (
    <>
      {children}
      {SystemPreviewer && previewOpen && previewFile && (
        <SystemPreviewer
          index={0}
          list={[previewFile as any]}
          onSwitchIndex={(idx: any) => {
            if (idx === null) handleClose();
          }}
        />
      )}
    </>
  );
};

/**
 * Top-level provider that wraps the app.
 * Wrapped in try/catch ErrorBoundary so that if plugin-ai isn't loaded,
 * the app still works normally without preview functionality.
 */
export class ChatFilePreviewErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return this.props.children;
    }
    return this.props.children;
  }
}

export const ChatFilePreviewProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <ChatFilePreviewErrorBoundary>
      <ChatFilePreviewInner>{children}</ChatFilePreviewInner>
    </ChatFilePreviewErrorBoundary>
  );
};
