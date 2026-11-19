// SPDX-License-Identifier: Apache-2.0

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp, attachmentFileTypes } from '@nocobase/client';
import { getGlobalChatBoxRuntime, type ChatBoxRuntime } from '@nocobase/plugin-ai/client-v2';
import { Modal, Button } from 'antd';
import { useTranslation } from './locale';
import { getChatScope, getChatScopes } from '../shared/chatScope';
import {
  buildSkillHubManifestMap,
  extractFilenameFromText,
  findLatestExecId,
  findManifestEntryForName,
  findSkillHubUrlForFile,
  getCachedSkillHubManifestMap,
  getDisplayNameCandidates,
  isKnownFileUrl,
  resolveDownloadUrl,
  rewriteMarkdownContent,
  stripFilenameNoise,
  type SkillHubManifestEntry,
} from '../shared/fileLinks';

export {
  buildSkillHubManifestMap,
  extractFilenameFromText,
  findLatestExecId,
  findManifestEntryForName,
  findSkillHubUrlForFile,
  getDisplayNameCandidates,
  isKnownFileUrl,
  resolveDownloadUrl,
  rewriteMarkdownContent,
  stripFilenameNoise,
  type SkillHubManifestEntry,
};

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

  const rawUrl = typeof file === 'string' ? file : file?.url || '';
  const isSafeSpecialScheme = /^(https?:|blob:|data:)/i.test(rawUrl);
  const resolvedUrl =
    !rawUrl || /^javascript:/i.test(rawUrl)
      ? ''
      : isSafeSpecialScheme
        ? rawUrl
        : `${window.location.origin}/${rawUrl.replace(/^\//, '')}`;

  return (
    <Modal
      open={index != null}
      title={file?.title || file?.filename || file?.name || t('File Preview (Fallback)')}
      onCancel={() => onSwitchIndex(null)}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button
            disabled={!resolvedUrl}
            onClick={() => resolvedUrl && window.open(resolvedUrl, '_blank', 'noopener,noreferrer')}
          >
            {t('Open Default')}
          </Button>
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
        {resolvedUrl ? (
          <iframe
            src={resolvedUrl}
            title={file?.title || file?.filename || file?.name || 'preview'}
            style={{ width: '100%', height: '100%', border: 'none', flex: 1 }}
          />
        ) : null}
      </div>
    </Modal>
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

  // Decorate links, mark previewable cards, and rewrite sandbox:/download/ URLs across all mounted AI chat scopes.
  useEffect(() => {
    const syncChatScopes = () => {
      const scopes = getChatScopes(app);
      if (scopes.length === 0) return;

      for (const { root, runtime } of scopes) {
        const session = readActiveSession(runtime.chatConversationModel.currentConversation, runtime);
        const attachments = [...session.attachments, ...runtime.chatSenderModel.attachments];
        const manifest = getCachedSkillHubManifestMap(session.messages);

        for (const msg of session.messages) {
          if (!msg) continue;
          if (typeof msg.content === 'string') {
            const nextContent = rewriteMarkdownContent(msg.content, session.messages);
            if (nextContent !== msg.content) {
              msg.content = nextContent;
            }
          } else if (msg.content && typeof msg.content === 'object' && typeof msg.content.content === 'string') {
            const nextContent = rewriteMarkdownContent(msg.content.content, session.messages);
            if (nextContent !== msg.content.content) {
              msg.content.content = nextContent;
            }
          }
        }

        root.querySelectorAll<HTMLElement>('.ant-attachment-list-card, .ant-bubble a[href]').forEach((card) => {
          const name = getDisplayNameFromCard(card);
          const href = card instanceof HTMLAnchorElement ? card.href : card.querySelector('a[href]')?.href || '';
          const file = href
            ? findFileByUrl(href, session.messages, attachments)
            : findFileByDisplayName(name, session.messages, attachments);
          const previewable = !!file || isKnownFileUrl(href) || !!findManifestEntryForName(name, manifest);
          card.classList.toggle('is-cached-previewable', previewable);
          if (card instanceof HTMLAnchorElement && previewable) {
            card.classList.add('ai-attachment-link');
          }
        });
      }
    };

    syncChatScopes();
    const timer = setInterval(syncChatScopes, 1000);
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
      const manifestMap = getCachedSkillHubManifestMap(currentMessages);
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
