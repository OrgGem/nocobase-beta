/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAPIClient } from '@nocobase/client';
import { useChatMessagesStore } from '@nocobase/plugin-ai/client';
import { PreviewModal, PreviewFile, isPreviewableFile } from './PreviewModal';
import { SessionBlobCache } from './SessionBlobCache';

// Define a reliable, context-isolated module-level RAM cache independent of the window object
export const AppRamCache = new Map<string, File | Blob>();

/**
 * Extract displayed filename from a FileListCard DOM element.
 */
function getDisplayNameFromCard(cardEl: HTMLElement): string {
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
    filename: att.filename || att.name,
    name: att.name || att.filename,
    title: att.title,
    extname: att.extname,
    mimetype: att.mimetype,
    size: att.size,
  };
}

/**
 * Find file metadata matching the displayed filename across all message attachments.
 */
function findFileByDisplayName(displayName: string, messages: any[], pendingAttachments: any[]): PreviewFile | null {
  if (!displayName) return null;

  // Search sent messages
  for (const msg of messages) {
    const content = msg.content || msg;
    const attachments = content?.attachments;
    if (!attachments?.length) continue;

    for (const att of attachments) {
      const attName = att.filename || att.name || '';
      if (attName === displayName || `${att.title || ''}${att.extname || ''}` === displayName) {
        return attToPreviewFile(att);
      }
    }
  }

  // Search pending (not yet sent) attachments
  for (const att of pendingAttachments || []) {
    const attName = att.filename || att.name || '';
    if (attName === displayName || `${att.title || ''}${att.extname || ''}` === displayName) {
      return attToPreviewFile(att);
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
  const [sessionId, setSessionId] = useState('');
  const apiClient = useAPIClient();

  // Read zustand stores via hooks — these re-render on changes
  const messages = useChatMessagesStore.use.messages();
  const pendingAttachments = useChatMessagesStore.use.attachments();

  // Keep latest values in refs for the click handler (avoids stale closures)
  const messagesRef = useRef(messages);
  const pendingAttachmentsRef = useRef(pendingAttachments);
  messagesRef.current = messages;
  pendingAttachmentsRef.current = pendingAttachments;

  // We don't have direct access to useChatConversationsStore (not exported).
  // Instead, we'll extract sessionId from the URL or from a data attribute on the DOM.
  // A simpler approach: use a global ref that gets populated via the axios interceptor.
  const currentSessionIdRef = useRef<string>('');

  // Track the current sessionId by intercepting the getMessages API call
  useEffect(() => {
    const reqInterceptor = apiClient.axios.interceptors.request.use((config) => {
      const url = config.url || '';
      // When loadMessages is called, the sessionId appears in the URL
      if (url.includes('aiConversations:getMessages')) {
        const match = url.match(/sessionId=([^&]+)/);
        if (match) {
          currentSessionIdRef.current = decodeURIComponent(match[1]);
        }
      }
      // When sendMessages is called, sessionId is in the request body
      if (url.includes('aiConversations:sendMessages') && config.data) {
        try {
          const data = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
          if (data?.sessionId) {
            currentSessionIdRef.current = data.sessionId;
          }
        } catch {
          // ignore
        }
      }
      return config;
    });

    return () => {
      apiClient.axios.interceptors.request.eject(reqInterceptor);
    };
  }, [apiClient]);

  // Track global drop and input change events to intercept file object selection ONLY for AI chat
  useEffect(() => {
    const handleDrop = (e: DragEvent) => {
      const target = e.target as HTMLElement;
      if (!target || !target.closest) return;
      if (!target.closest('.ant-x-sender') && !target.closest('.ant-x-attachments')) return;

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
      if (!target.closest('.ant-x-sender') && !target.closest('.ant-x-attachments')) return;

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

  // Periodically check pure RAM cache and ONLY mark DOM cards that physically exist in local JS memory.
  // This automatically rules out external database checks and prevents 403s on old un-cached files.
  useEffect(() => {
    const checkInterval = setInterval(() => {
      // Isolate strictly to AI module components! (AI Chat outputs Ant Design X attachments)
      const aiContainers = document.querySelectorAll('.ant-x-sender, .ant-x-attachments, .ant-x-message');
      
      const cards: Element[] = [];
      aiContainers.forEach(container => {
        container.querySelectorAll('div[class*="attachment-list-card"]:not([class*="attachment-list-card-"])').forEach(c => cards.push(c));
      });

      cards.forEach(card => {
        const el = card as HTMLElement;
        const displayName = getDisplayNameFromCard(el);
        const urlNodes = el.querySelectorAll('a');
        let fallbackUrl = '';
        urlNodes.forEach((node) => {
          if (node.href) fallbackUrl = node.href;
        });

        // Resolve real file name from data store
        const file = findFileByDisplayName(displayName, messagesRef.current, pendingAttachmentsRef.current) || 
                     findFileByUrl(fallbackUrl, messagesRef.current, pendingAttachmentsRef.current);
        const realName = file?.filename || file?.name || file?.title;

        // Strict RAM cache check
        const cacheHitName = realName && AppRamCache.has(realName) ? realName 
                           : (displayName && AppRamCache.has(displayName) ? displayName : null);

        if (cacheHitName) {
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
      div[class*="attachment-list-card"]:not([class*="attachment-list-card-"]) {
        position: relative !important;
        cursor: pointer !important;
      }
      /* Prevent pointer events on inner text and icons so the outer div receives the absolute click */
      div[class*="attachment-list-card"]:not([class*="attachment-list-card-"]) a,
      div[class*="attachment-list-card"]:not([class*="attachment-list-card-"]) [class*="-icon"],
      div[class*="attachment-list-card"]:not([class*="attachment-list-card-"]) span {
        pointer-events: none !important;
      }
      /* Re-enable pointer events for the delete button specifically */
      div[class*="attachment-list-card"]:not([class*="attachment-list-card-"]) [class*="-remove"],
      div[class*="attachment-list-card"]:not([class*="attachment-list-card-"]) button,
      div[class*="attachment-list-card"]:not([class*="attachment-list-card-"]) .ant-btn {
        pointer-events: auto !important;
      }
      /* Visual "Preview" badge at the top-left corner using proper SVG */
      div[class*="attachment-list-card"]:not([class*="attachment-list-card-"]).is-cached-previewable::after {
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
      div[class*="attachment-list-card"]:not([class*="attachment-list-card-"]).is-cached-previewable .ant-upload-list-item-thumbnail {
        opacity: 0.2;
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

      // Find closest FileCard element — uses ant-design/x class pattern
      const cardEl = el.closest('[class*="attachment-list-card"]:not([class*="attachment-list-card-"])') as HTMLElement;
      if (!cardEl) return;

      // Skip remove button clicks
      if (el.closest('[class*="-remove"]') || el.closest('.ant-btn')) return;

      // Ensure we only hijack the click if we VERIFIED the file exists in our cache!
      // This strictly prevents the 403 API fallback scenario.
      if (!cardEl.classList.contains('is-cached-previewable')) return;

      const displayName = getDisplayNameFromCard(cardEl);
      const urlNodes = cardEl.querySelectorAll('a');
      let fallbackUrl = '';
      urlNodes.forEach((node) => {
        if (node.href) fallbackUrl = node.href;
      });

      const file = findFileByDisplayName(displayName, messagesRef.current, pendingAttachmentsRef.current) || 
                   findFileByUrl(fallbackUrl, messagesRef.current, pendingAttachmentsRef.current);

      if (!file) return;
      if (!isPreviewableFile(file)) return;

      e.preventDefault();
      e.stopPropagation();

      setSessionId(currentSessionIdRef.current || '');
      setPreviewFile(file);
      setPreviewOpen(true);
    };

    document.addEventListener('click', handler, { capture: true });
    return () => document.removeEventListener('click', handler, { capture: true });
  }, []);

  // Cleanup cache when conversations are deleted
  useEffect(() => {
    const interceptor = apiClient.axios.interceptors.response.use((response) => {
      try {
        const url = response.config?.url || '';
        if (url.includes('aiConversations:destroy')) {
          const match = url.match(/filterByTk=([^&]+)/);
          if (match) {
            SessionBlobCache.clearSession(decodeURIComponent(match[1])).catch(() => {});
          }
        }
      } catch {
        // ignore
      }
      return response;
    });

    return () => {
      apiClient.axios.interceptors.response.eject(interceptor);
    };
  }, [apiClient]);

  const handleClose = useCallback(() => {
    setPreviewOpen(false);
    setPreviewFile(null);
  }, []);

  return (
    <>
      {children}
      <PreviewModal open={previewOpen} file={previewFile} sessionId={sessionId} onClose={handleClose} />
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
