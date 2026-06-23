import { DownloadOutlined } from '@ant-design/icons';
import type { Application } from '@nocobase/client-v2';
import { useChatConversationsStore, useChatMessagesStore } from '@nocobase/plugin-ai/client-v2';
import { filePreviewTypes, type FilePreviewerProps } from '@nocobase/plugin-file-manager/client-v2';
import { Alert, Button, Modal, Space, message } from 'antd';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type UnknownRecord = Record<string, unknown>;
type PreviewFile = UnknownRecord;
type I18nLike = {
  t: (key: string, options?: Record<string, unknown>) => string;
};
type AppLike = Application & {
  i18n?: I18nLike;
};
type ChatSessionSnapshot = {
  attachments?: unknown[];
  messages?: unknown[];
};
type ChatMessagesSnapshot = {
  getSessionState?: (sessionId?: string) => ChatSessionSnapshot;
  sessions?: Record<string, ChatSessionSnapshot>;
};
type ChatConversationsSnapshot = {
  currentConversation?: string;
};
type PreviewWindow = Window & {
  __pluginAiChatFilePreviewV2Cleanup?: () => void;
};

const NAMESPACE = 'plugin-ai-chat-file-preview';
const CHAT_DEFAULT_SESSION_KEY = '__draft__';
const FILE_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'csv',
  'ppt',
  'pptx',
  'txt',
  'md',
  'json',
  'xml',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
]);

const browserFileCache = new Map<string, PreviewFile>();
let appRef: AppLike | null = null;

const t = (key: string) => appRef?.i18n?.t(key, { ns: NAMESPACE }) || key;

const isRecord = (value: unknown): value is UnknownRecord => typeof value === 'object' && value !== null;

const getString = (record: UnknownRecord | null, key: string) => {
  const value = record?.[key];
  return typeof value === 'string' ? value : '';
};

const stripQueryAndHash = (value: string) => value.split('?')[0].split('#')[0];

const getNameFromUrl = (url?: string) => {
  if (!url) {
    return '';
  }
  const clean = stripQueryAndHash(url);
  const index = clean.lastIndexOf('/');
  const name = index >= 0 ? clean.slice(index + 1) : clean;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};

const getExtFromName = (value?: string) => {
  if (!value) {
    return '';
  }
  const clean = stripQueryAndHash(value);
  const index = clean.lastIndexOf('.');
  return index >= 0 ? clean.slice(index + 1).toLowerCase() : '';
};

const normalizeName = (value?: string) =>
  (value || '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^.*[\\/]/, '')
    .toLowerCase();

const extractFilenameFromText = (value?: string) => {
  if (!value) {
    return '';
  }
  const match = value.match(/[^\s"'<>()[\]{}]+\.([a-z0-9]{2,8})/i);
  if (!match || !FILE_EXTENSIONS.has(match[1].toLowerCase())) {
    return '';
  }
  return match[0];
};

const resolveFileUrl = (file: unknown) => {
  if (typeof file === 'string') {
    return file;
  }
  const record = isRecord(file) ? file : null;
  return (
    getString(record, 'preview') ||
    getString(record, 'url') ||
    getString(record, 'downloadUrl') ||
    getString(record, 'path')
  );
};

const getDisplayName = (file: unknown) => {
  if (typeof File !== 'undefined' && file instanceof File) {
    return file.name;
  }
  const record = isRecord(file) ? file : null;
  return (
    getString(record, 'filename') ||
    getString(record, 'name') ||
    getString(record, 'title') ||
    getNameFromUrl(resolveFileUrl(file)) ||
    'file'
  );
};

const getCandidateNames = (file: unknown) => {
  const url = resolveFileUrl(file);
  const names = new Set<string>();
  for (const value of [getDisplayName(file), getNameFromUrl(url), extractFilenameFromText(getDisplayName(file))]) {
    const normalized = normalizeName(value);
    if (normalized) {
      names.add(normalized);
    }
  }
  return names;
};

const normalizeUrlForCompare = (url?: string) => {
  if (!url) {
    return '';
  }
  try {
    const parsed = new URL(url, window.location.href);
    return decodeURIComponent(`${parsed.pathname}${parsed.search}`).toLowerCase();
  } catch {
    return decodeURIComponent(url).toLowerCase();
  }
};

const isFileLikeUrl = (url?: string) => {
  if (!url || /^(mailto|tel|javascript):/i.test(url)) {
    return false;
  }
  if (/^(blob|data):/i.test(url) || /\/api\/(attachments:stream|filePreviewAuth:download)/.test(url)) {
    return true;
  }
  return FILE_EXTENSIONS.has(getExtFromName(url));
};

const toPreviewFile = (value: unknown): PreviewFile | null => {
  if (!value) {
    return null;
  }
  if (typeof File !== 'undefined' && value instanceof File) {
    return {
      originFileObj: value,
      filename: value.name,
      name: value.name,
      title: value.name,
      mimetype: value.type,
      type: value.type,
      collectionName: 'aiFiles',
    };
  }
  if (Array.isArray(value)) {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const url = resolveFileUrl(value);
  const filename = getDisplayName(value);
  if (!url && !filename && !value.id && !value.uid) {
    return null;
  }
  return {
    ...value,
    url,
    filename,
    name: getString(value, 'name') || filename,
    title: getString(value, 'title') || filename,
    collectionName: getString(value, 'collectionName') || getString(value, 'collection') || 'aiFiles',
  };
};

const pushPreviewFile = (files: PreviewFile[], value: unknown) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      pushPreviewFile(files, item);
    }
    return;
  }
  const previewFile = toPreviewFile(value);
  if (previewFile) {
    files.push(previewFile);
  }
};

const collectMessageFiles = (files: PreviewFile[], message: unknown) => {
  if (!isRecord(message)) {
    return;
  }
  pushPreviewFile(files, message.attachments);
  const content = isRecord(message.content) ? message.content : null;
  pushPreviewFile(files, content?.attachments);
  const subAgentConversations = content?.subAgentConversations;
  if (Array.isArray(subAgentConversations)) {
    for (const conversation of subAgentConversations) {
      if (!isRecord(conversation) || !Array.isArray(conversation.messages)) {
        continue;
      }
      for (const nestedMessage of conversation.messages) {
        collectMessageFiles(files, nestedMessage);
      }
    }
  }
};

const getSessionSnapshot = (state: ChatMessagesSnapshot, sessionId?: string) => {
  if (typeof state.getSessionState === 'function') {
    return state.getSessionState(sessionId);
  }
  return state.sessions?.[sessionId || CHAT_DEFAULT_SESSION_KEY] || {};
};

const getChatPreviewFiles = () => {
  const files = [...browserFileCache.values()];
  const messagesState = useChatMessagesStore.getState() as ChatMessagesSnapshot;
  const conversationsState = useChatConversationsStore.getState() as ChatConversationsSnapshot;
  const sessionIds = Array.from(new Set([conversationsState.currentConversation, undefined]));

  for (const sessionId of sessionIds) {
    const session = getSessionSnapshot(messagesState, sessionId);
    pushPreviewFile(files, session.attachments);
    for (const chatMessage of session.messages || []) {
      collectMessageFiles(files, chatMessage);
    }
  }

  const seen = new Set<string>();
  return files.filter((file) => {
    const key = normalizeUrlForCompare(resolveFileUrl(file)) || normalizeName(getDisplayName(file));
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const findPreviewFile = (label?: string, href?: string) => {
  const files = getChatPreviewFiles();
  const normalizedHref = normalizeUrlForCompare(href);
  if (normalizedHref) {
    const byUrl = files.find((file) => {
      const fileUrl = normalizeUrlForCompare(resolveFileUrl(file));
      return (
        fileUrl && (fileUrl === normalizedHref || fileUrl.includes(normalizedHref) || normalizedHref.includes(fileUrl))
      );
    });
    if (byUrl) {
      return byUrl;
    }
  }

  const namesToMatch = new Set<string>();
  for (const value of [label, href ? getNameFromUrl(href) : '', extractFilenameFromText(label)]) {
    const normalized = normalizeName(value);
    if (normalized) {
      namesToMatch.add(normalized);
    }
  }

  return files.find((file) => {
    const candidateNames = getCandidateNames(file);
    for (const name of namesToMatch) {
      if (candidateNames.has(name)) {
        return true;
      }
    }
    return false;
  });
};

const createFallbackFile = (href: string, label?: string): PreviewFile => {
  const filename = normalizeName(extractFilenameFromText(label) || getNameFromUrl(href) || label || 'file');
  return {
    url: href,
    filename,
    name: filename,
    title: filename,
    collectionName: 'aiFiles',
  };
};

const openFallbackDownload = (file: unknown) => {
  const url = resolveFileUrl(file);
  if (!url) {
    message.error(t('Failed to download file'));
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
};

function DetachedPreviewModal(props: { file: PreviewFile; onDestroy: () => void }) {
  const { file, onDestroy } = props;
  const [open, setOpen] = useState(true);
  const Previewer = useMemo(() => filePreviewTypes.getTypeByFile(file)?.Previewer, [file]);
  const handleClose = useCallback(() => setOpen(false), []);
  const handleDownload = useCallback(() => openFallbackDownload(file), [file]);

  useEffect(() => {
    if (!open) {
      const timer = window.setTimeout(onDestroy, 250);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [onDestroy, open]);

  if (Previewer) {
    return (
      <Previewer
        file={file}
        index={0}
        list={[file]}
        open={open}
        onOpenChange={setOpen}
        onClose={handleClose}
        onDownload={handleDownload as FilePreviewerProps['onDownload']}
      />
    );
  }

  return (
    <Modal
      open={open}
      title={getDisplayName(file)}
      onCancel={handleClose}
      footer={
        <Space>
          <Button icon={<DownloadOutlined />} onClick={handleDownload}>
            {t('Download')}
          </Button>
          <Button onClick={handleClose}>{t('Close')}</Button>
        </Space>
      }
      width={560}
      centered
    >
      <Alert
        type="info"
        description={t('This file type cannot be previewed. Click Download to save the file.')}
        showIcon
      />
    </Modal>
  );
}

const mountPreview = (file: PreviewFile) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = createRoot(container);
  const destroy = () => {
    root?.unmount();
    root = null;
    container.remove();
  };
  root.render(<DetachedPreviewModal file={file} onDestroy={destroy} />);
};

const rememberBrowserFiles = (files?: FileList | File[] | null) => {
  if (!files) {
    return;
  }
  for (const file of Array.from(files)) {
    const previewFile = toPreviewFile(file);
    if (previewFile) {
      browserFileCache.set(normalizeName(file.name), previewFile);
    }
  }
};

const findClickableFileTarget = (eventTarget: EventTarget | null) => {
  if (!(eventTarget instanceof Element)) {
    return null;
  }
  const anchor = eventTarget.closest('a[href]') as HTMLAnchorElement | null;
  const card = eventTarget.closest(
    '.ant-attachment, .ant-upload-list-item, [data-ai-chat-file-preview-card]',
  ) as HTMLElement | null;
  if (!anchor && !card) {
    return null;
  }
  const href =
    anchor?.getAttribute('href') || card?.querySelector<HTMLAnchorElement>('a[href]')?.getAttribute('href') || '';
  const label = anchor?.textContent || card?.textContent || getNameFromUrl(href);
  return { anchor, card, href, label };
};

const markPreviewTargets = () => {
  for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    const href = anchor.getAttribute('href') || '';
    const label = anchor.textContent || getNameFromUrl(href);
    if (isFileLikeUrl(href) || findPreviewFile(label, href)) {
      anchor.dataset.aiChatFilePreview = 'true';
    }
  }
  for (const card of Array.from(document.querySelectorAll<HTMLElement>('.ant-attachment, .ant-upload-list-item'))) {
    const label = card.textContent || '';
    if (findPreviewFile(label)) {
      card.dataset.aiChatFilePreviewCard = 'true';
    }
  }
};

const handleClick = (event: MouseEvent) => {
  const target = findClickableFileTarget(event.target);
  if (!target) {
    return;
  }
  const file =
    findPreviewFile(target.label, target.href) ||
    (isFileLikeUrl(target.href) ? createFallbackFile(target.href, target.label) : null);
  if (!file) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  mountPreview(file);
};

const handleDrop = (event: DragEvent) => {
  rememberBrowserFiles(event.dataTransfer?.files || null);
};

const handleChange = (event: Event) => {
  const input = event.target instanceof HTMLInputElement ? event.target : null;
  if (input?.type === 'file') {
    rememberBrowserFiles(input.files);
  }
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
  document.addEventListener('drop', handleDrop, true);
  document.addEventListener('change', handleChange, true);
  const interval = window.setInterval(markPreviewTargets, 1500);
  markPreviewTargets();

  previewWindow.__pluginAiChatFilePreviewV2Cleanup = () => {
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('drop', handleDrop, true);
    document.removeEventListener('change', handleChange, true);
    window.clearInterval(interval);
    style.remove();
    delete previewWindow.__pluginAiChatFilePreviewV2Cleanup;
  };
}
