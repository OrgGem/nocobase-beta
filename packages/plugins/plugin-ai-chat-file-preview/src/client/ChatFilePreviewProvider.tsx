// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '@nocobase/client';
import { getGlobalChatBoxRuntime, type ChatBoxRuntime } from '@nocobase/plugin-ai/client-v2';
import { message } from 'antd';
import { useTranslation } from './locale';
import { getChatScope, getChatScopes } from '../shared/chatScope';
import {
  openChatDocumentPreview,
  resolveDocumentSourceForElement,
  type ChatPreviewAppLike,
  type DocumentPreviewSource,
} from '../shared/documentResolver';
import {
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
  type DocumentPreviewSource,
  type SkillHubManifestEntry,
};

const EMPTY_MESSAGES: unknown[] = [];
const EMPTY_ATTACHMENTS: unknown[] = [];

type ChatSessionSnapshot = {
  messages?: unknown[];
  attachments?: unknown[];
};

export function readActiveSession(
  sessionId?: string,
  runtime?: ChatBoxRuntime,
): { messages: unknown[]; attachments: unknown[] } {
  try {
    const activeRuntime = runtime || getGlobalChatBoxRuntime();
    const session = activeRuntime.chatMessageModel.getSessionState(sessionId) as ChatSessionSnapshot;
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
      const last = messages.length ? (messages[messages.length - 1] as Record<string, unknown> | undefined) : undefined;
      const signature = `${currentConversation || '__draft__'}|${messages.length}|${attachments.length}|${String(
        last?.key ?? '',
      )}|${String(last?.loading ?? '')}`;
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

const ChatFilePreviewInner: React.FC = () => {
  const app = useApp();
  const { t } = useTranslation();

  // Decorate previewable document cards and links across all mounted AI chat scopes.
  useEffect(() => {
    const appLike = app as unknown as ChatPreviewAppLike;
    const syncChatScopes = () => {
      const scopes = getChatScopes(app);
      if (scopes.length === 0) return;

      for (const scope of scopes) {
        scope.root
          .querySelectorAll<HTMLElement>(
            '.ant-attachment-list-card, .ant-upload-list-item, .ant-bubble a[href], a[href]',
          )
          .forEach((el) => {
            const source = resolveDocumentSourceForElement(appLike, scope, el);
            const previewable = Boolean(source);
            el.classList.toggle('is-cached-previewable', previewable);
            if (el instanceof HTMLAnchorElement) {
              el.classList.toggle('ai-attachment-link', previewable);
            }
          });
      }
    };

    syncChatScopes();
    const timer = setInterval(syncChatScopes, 1000);
    return () => clearInterval(timer);
  }, [app]);

  // Inject visual cues for previewable document cards/links without interfering with images or remove buttons.
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      .ant-attachment-list-card.is-cached-previewable {
        position: relative !important;
        cursor: pointer !important;
      }
      .ant-attachment-list-card.is-cached-previewable [class*="-remove"],
      .ant-attachment-list-card.is-cached-previewable button,
      .ant-attachment-list-card.is-cached-previewable .ant-btn {
        pointer-events: auto !important;
      }
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
    `;
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, []);

  // Capture clicks on resolved server documents inside mounted chat scopes and delegate to plugin-file-preview-auth.
  useEffect(() => {
    const appLike = app as unknown as ChatPreviewAppLike;
    const handler = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

      const scope = getChatScope(app, target);
      if (!scope) return;

      const source = resolveDocumentSourceForElement(appLike, scope, target);
      if (!source) return;

      event.preventDefault();
      event.stopPropagation();

      openChatDocumentPreview(appLike, source, () => {
        message.warning(
          t(
            'Please enable or update Authenticated File Previewer (plugin-file-preview-auth) to preview this document.',
          ),
        );
      });
    };

    document.addEventListener('click', handler, { capture: true });
    return () => document.removeEventListener('click', handler, { capture: true });
  }, [app, t]);

  return null;
};

/**
 * Top-level provider that wraps the app.
 * Wrapped in ErrorBoundary so that if plugin-ai isn't loaded, the app continues rendering normally.
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
