/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp, attachmentFileTypes } from '@nocobase/client';
import { getGlobalChatBoxRuntime, type ChatBoxRuntime } from '@nocobase/plugin-ai/client-v2';
import { Modal, Button } from 'antd';
import { useTranslation } from './locale';
import { getChatScope, getChatScopes } from '../shared/chatScope';

const EMPTY_MESSAGES: any[] = [];
const EMPTY_ATTACHMENTS: any[] = [];

type ChatSessionSnapshot = {
  messages?: any[];
  attachments?: any[];
};

// plugin-ai v2 exposes FlowEngine models (not zustand), so the v1 provider cannot subscribe
// reactively. Poll the global runtime and only setState when the active session's content
// actually changes (signature compare) to keep effect deps like [messages] stable.
export function readActiveSession(
  sessionId?: string,
  runtime?: ChatBoxRuntime,
): { messages: any[]; attachments: any[] } {
  try {
    const activeRuntime = runtime || getGlobalChatBoxRuntime();
    const session: ChatSessionSnapshot = activeRuntime.chatMessageModel.getSessionState(
      sessionId,
    ) as ChatSessionSnapshot;
    return {
      messages: Array.isArray(session.messages) ? session.messages : EMPTY_MESSAGES,
      attachments: Array.isArray(session.attachments) ? session.attachments : EMPTY_ATTACHMENTS,
    };
  } catch {
    return { messages: EMPTY_MESSAGES, attachments: EMPTY_ATTACHMENTS };
  }
}

export function useChatRuntimeState() {
  const [snapshot, setSnapshot] = useState(() => ({
    currentConversation: undefined as string | undefined,
    messages: EMPTY_MESSAGES,
    attachments: EMPTY_ATTACHMENTS,
  }));
  const signatureRef = useRef('');

  useEffect(() => {
    const sync = () => {
      let currentConversation: string | undefined;
      try {
        currentConversation = getGlobalChatBoxRuntime().chatConversationModel.currentConversation;
      } catch {
        currentConversation = undefined;
      }
      const { messages, attachments } = readActiveSession(currentConversation);
      const signature = `${currentConversation || '__draft__'}|${messages.length}|${attachments.length}|${
        messages.length ? messages[messages.length - 1]?.key || '' : ''
      }|${messages.length ? messages[messages.length - 1]?.loading ?? '' : ''}`;
      if (signature !== signatureRef.current) {
        signatureRef.current = signature;
        setSnapshot({ currentConversation, messages, attachments });
      }
    };
    sync();
    const timer = setInterval(sync, 800);
    return () => clearInterval(timer);
  }, []);

  return snapshot;
}

// Ant Design X 1.1.0 prefixes: sender -> ant-sender, bubble -> ant-bubble, attachment -> ant-attachment.

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
  originFileObj?: Blob;
  [key: string]: any;
}

// ─── Inline Fallback Previewer ───────────────────────────────────────────
// Hand-crafted fallback so if plugin-file-preview-auth is disabled or unavaliable,
// the AI chat still gets a 90% wide modal rather than doing nothing.

function FallbackModalPreviewer({ index, list, onSwitchIndex }: any) {
  const { t } = useTranslation();
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
      title={file?.title || file?.filename || file?.name || t('File Preview (Fallback)')}
      onCancel={() => onSwitchIndex(null)}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={() => window.open(resolvedUrl, '_blank')}>{t('Open Default')}</Button>
          <Button onClick={() => onSwitchIndex(null)}>{t('Close')}</Button>
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
    originFileObj: att.originFileObj || (att instanceof Blob ? att : undefined),
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
  const attachments = [...pendingAttachments];
  for (const msg of messages) {
    const content = msg.content || msg;
    if (Array.isArray(content?.attachments)) attachments.push(...content.attachments);
  }

  const matches = attachments.filter((attachment) => {
    const name = attachment.filename || attachment.name || '';
    const title = `${attachment.title || ''}${attachment.extname || ''}`;
    return displayNames.includes(name) || displayNames.includes(title);
  });
  return matches.length === 1 ? attToPreviewFile(matches[0]) : null;
}

/**
 * Find file metadata matching the extracted URL
 */
function findFileByUrl(url: string, messages: any[], pendingAttachments: any[]): PreviewFile | null {
  if (!url) return null;
  const matchUrl = (u1: string, u2: string) => {
    if (!u1 || !u2) return false;
    try {
      return new URL(u1, location.href).href === new URL(u2, location.href).href;
    } catch {
      return u1 === u2;
    }
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
 * Preview controls for files in mounted AI chat runtimes.
 */
const ChatFilePreviewInner: React.FC = () => {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<PreviewFile | null>(null);
  const app = useApp();
  const objectUrlRef = useRef<string>();

  const { messages } = useChatRuntimeState();

  // Decorate links only within a mounted AI chat.
  useEffect(() => {
    const decorateLinks = () => {
      for (const { root } of getChatScopes(app)) {
        root
          .querySelectorAll<HTMLAnchorElement>(
            '.ant-bubble a[href*="skillHub:download"], .ant-bubble a[href*="worker-monitor"]',
          )
          .forEach((link) => {
            link.classList.add('ai-attachment-link');
          });
      }
    };
    const timer = setInterval(decorateLinks, 1000);
    return () => clearInterval(timer);
  }, [app]);

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

  // Mark only file cards belonging to a mounted AI chat.
  useEffect(() => {
    const markCards = () => {
      for (const { root, runtime } of getChatScopes(app)) {
        const session = readActiveSession(runtime.chatConversationModel.currentConversation, runtime);
        const attachments = [...session.attachments, ...runtime.chatSenderModel.attachments];
        const manifest = buildSkillHubManifestMap(session.messages);
        root.querySelectorAll<HTMLElement>('.ant-attachment-list-card, .ant-bubble a[href]').forEach((card) => {
          const name = getDisplayNameFromCard(card);
          const href = card instanceof HTMLAnchorElement ? card.href : card.querySelector('a[href]')?.href || '';
          const file = href
            ? findFileByUrl(href, session.messages, attachments)
            : findFileByDisplayName(name, session.messages, attachments);
          const previewable = !!file || isKnownFileUrl(href) || !!findManifestEntryForName(name, manifest);
          card.classList.toggle('is-cached-previewable', previewable);
          if (card instanceof HTMLAnchorElement && previewable) card.classList.add('ai-attachment-link');
        });
      }
    };
    markCards();
    const timer = setInterval(markCards, 1000);
    return () => clearInterval(timer);
  }, [app]);

  // Inject global CSS for explicit UI and native z-index click interception for child texts/tags
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      .ant-attachment-list-card.is-cached-previewable {
        position: relative !important;
        cursor: pointer !important;
      }
      /* Prevent pointer events on inner text and icons so the outer div receives the absolute click */
      .ant-attachment-list-card.is-cached-previewable a,
      .ant-attachment-list-card.is-cached-previewable [class*="-icon"],
      .ant-attachment-list-card.is-cached-previewable span {
        pointer-events: none !important;
      }
      /* Re-enable pointer events for the delete button specifically */
      .ant-attachment-list-card.is-cached-previewable [class*="-remove"],
      .ant-attachment-list-card.is-cached-previewable button,
      .ant-attachment-list-card.is-cached-previewable .ant-btn {
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
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const scope = getChatScope(app, el);
      if (!scope) return;
      const runtime: ChatBoxRuntime = scope.runtime;
      const session = readActiveSession(runtime.chatConversationModel.currentConversation, runtime);
      const currentMessages = session.messages;
      const currentAttachments = [...session.attachments, ...runtime.chatSenderModel.attachments];

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

      let file = originalFallbackUrl
        ? findFileByUrl(originalFallbackUrl, currentMessages, currentAttachments)
        : findFileByDisplayName(displayName, currentMessages, currentAttachments);

      const normalizedDisplayName = extractFilenameFromText(displayName);

      // Prefer the server-provided skillhub manifest: it carries the real downloadUrl keyed by
      // filename, so a click resolves correctly even when the LLM wrote a broken `download/...` link.
      const manifestMap = buildSkillHubManifestMap(currentMessages);
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

      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = undefined;
      if (file.originFileObj instanceof Blob && !file.url) {
        const url = URL.createObjectURL(file.originFileObj);
        objectUrlRef.current = url;
        file = { ...file, id: undefined, uid: undefined, preview: undefined, url };
      }

      setPreviewFile(file);
      setPreviewOpen(true);
    };

    document.addEventListener('click', handler, { capture: true });
    return () => document.removeEventListener('click', handler, { capture: true });
  }, [app]);

  const handleClose = useCallback(() => {
    setPreviewOpen(false);
    setPreviewFile(null);
  }, []);

  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    },
    [],
  );

  const SystemPreviewer = useMemo(() => {
    if (!previewFile || !previewOpen) return null;
    const type = attachmentFileTypes.getTypeByFile(previewFile);
    return type?.Previewer || FallbackModalPreviewer;
  }, [previewFile, previewOpen]);

  return (
    <>
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

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.warn('[plugin-ai-chat-file-preview] ErrorBoundary caught:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return null;
    }
    return this.props.children;
  }
}

export const ChatFilePreviewProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <>
      {children}
      <ChatFilePreviewErrorBoundary>
        <ChatFilePreviewInner />
      </ChatFilePreviewErrorBoundary>
    </>
  );
};
