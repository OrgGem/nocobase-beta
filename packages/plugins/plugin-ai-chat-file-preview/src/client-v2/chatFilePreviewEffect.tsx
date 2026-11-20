// SPDX-License-Identifier: Apache-2.0

import type { Application } from '@nocobase/client-v2';
import { message } from 'antd';
import { getChatScope, getChatScopes } from '../shared/chatScope';
import {
  openChatDocumentPreview,
  resolveDocumentSourceForElement,
  type ChatPreviewAppLike,
} from '../shared/documentResolver';

type I18nLike = {
  t: (key: string, options?: Record<string, unknown>) => string;
};
type AppLike = Application &
  ChatPreviewAppLike & {
    i18n?: I18nLike;
  };
type PreviewWindow = Window & {
  __pluginAiChatFilePreviewV2Cleanup?: () => void;
};

const NAMESPACE = 'plugin-ai-chat-file-preview';

let appRef: AppLike | null = null;

const t = (key: string) => appRef?.i18n?.t(key, { ns: NAMESPACE }) || key;

const markPreviewTargets = () => {
  const app = appRef;
  if (!app) return;
  const scopes = getChatScopes(app);
  if (scopes.length === 0) return;

  for (const scope of scopes) {
    for (const anchor of Array.from(scope.root.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
      const source = resolveDocumentSourceForElement(app, scope, anchor);
      if (source) {
        anchor.dataset.aiChatFilePreview = 'true';
      } else {
        delete anchor.dataset.aiChatFilePreview;
      }
    }
    for (const card of Array.from(
      scope.root.querySelectorAll<HTMLElement>('.ant-attachment-list-card, .ant-upload-list-item'),
    )) {
      const source = resolveDocumentSourceForElement(app, scope, card);
      if (source) {
        card.dataset.aiChatFilePreviewCard = 'true';
      } else {
        delete card.dataset.aiChatFilePreviewCard;
      }
    }
  }
};

const handleClick = (event: MouseEvent) => {
  const app = appRef;
  if (
    !app ||
    !(event.target instanceof Element) ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }

  const scope = getChatScope(app, event.target);
  if (!scope) return;

  const source = resolveDocumentSourceForElement(app, scope, event.target);
  if (!source) return;

  event.preventDefault();
  event.stopPropagation();

  openChatDocumentPreview(app, source, () => {
    message.warning(
      t('Please enable or update Authenticated File Previewer (plugin-file-preview-auth) to preview this document.'),
    );
  });
};

export function installAiChatFilePreviewEffect(app: Application) {
  appRef = app as AppLike;
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  const previewWindow = window as PreviewWindow;
  if (previewWindow.__pluginAiChatFilePreviewV2Cleanup) {
    return;
  }

  const style = document.createElement('style');
  style.textContent = `
    [data-ai-chat-file-preview="true"],
    [data-ai-chat-file-preview-card="true"] {
      cursor: pointer;
    }
    [data-ai-chat-file-preview="true"]:hover {
      text-decoration: underline;
    }
  `;
  document.head.appendChild(style);

  document.addEventListener('click', handleClick, true);
  const interval = window.setInterval(markPreviewTargets, 1500);
  markPreviewTargets();

  previewWindow.__pluginAiChatFilePreviewV2Cleanup = () => {
    document.removeEventListener('click', handleClick, true);
    window.clearInterval(interval);
    style.remove();
    appRef = null;
    delete previewWindow.__pluginAiChatFilePreviewV2Cleanup;
  };
}
