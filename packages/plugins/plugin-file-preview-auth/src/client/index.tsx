/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DownloadOutlined,
  LeftOutlined,
  RightOutlined,
  CopyOutlined,
  SyncOutlined,
  ClockCircleOutlined,
  CheckCircleOutlined,
  ScanOutlined,
  ThunderboltOutlined,
  EyeOutlined,
} from '@ant-design/icons';
import { Modal, Button, Spin, Alert, Space, message, Tabs, Tag } from 'antd';
import { Plugin, useAPIClient, attachmentFileTypes, matchMimetype, useComponent } from '@nocobase/client';
// @ts-ignore
import { filePreviewTypes } from '@nocobase/plugin-file-manager/client';
import { useT } from './locale';
import { AIFilePreviewAction, registerFilePreviewAIWorkContext } from './AIFilePreviewAction';

// ─── Supported MIME types ────────────────────────────────────────────

const PDF_MIME_TYPES = ['application/pdf'];
const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp'];
const TEXT_MIME_TYPES = [
  'text/plain',
  'text/csv',
  'text/html',
  'text/css',
  'text/javascript',
  'application/json',
  'application/xml',
  'text/xml',
  'text/yaml',
  'application/x-yaml',
];
const DOCX_MIME_TYPES = ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const XLSX_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
];

const PDF_EXTS = ['pdf'];
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
const TEXT_EXTS = ['txt', 'csv', 'html', 'css', 'js', 'json', 'xml', 'log', 'md', 'yaml', 'yml', 'xaml'];
const DOCX_EXTS = ['docx'];
const XLSX_EXTS = ['xlsx', 'xls'];
const PPTX_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
];
const PPTX_EXTS = ['pptx', 'ppt'];
const IMAGE_PLACEHOLDER_ICON_MAP: Record<string, string> = {
  png: 'png-200-200.png',
  jpg: 'jpeg-200-200.png',
  jpeg: 'jpeg-200-200.png',
  gif: 'gif-200-200.png',
  webp: 'png-200-200.png',
  bmp: 'png-200-200.png',
  svg: 'svg-200-200.png',
};
const MIME_IMAGE_PLACEHOLDER_ICON_MAP: Record<string, string> = {
  'image/png': IMAGE_PLACEHOLDER_ICON_MAP.png,
  'image/jpeg': IMAGE_PLACEHOLDER_ICON_MAP.jpeg,
  'image/jpg': IMAGE_PLACEHOLDER_ICON_MAP.jpeg,
  'image/gif': IMAGE_PLACEHOLDER_ICON_MAP.gif,
  'image/webp': IMAGE_PLACEHOLDER_ICON_MAP.webp,
  'image/bmp': IMAGE_PLACEHOLDER_ICON_MAP.bmp,
  'image/svg+xml': IMAGE_PLACEHOLDER_ICON_MAP.svg,
};

// ─── Utility functions ──────────────────────────────────────────────

function getPreviewFileRecord(file: any) {
  if (!file || typeof file === 'string') {
    return file;
  }

  const response = file.response;
  if (!response || typeof response !== 'object') {
    return file;
  }

  return {
    ...response,
    ...file,
    id: file.id ?? response.id,
    uid: file.uid ?? response.uid,
    url: file.url ?? response.url,
    preview: file.preview || response.preview,
    filename: file.filename ?? response.filename,
    name: file.name ?? response.name,
    title: file.title ?? response.title,
    extname: file.extname ?? response.extname,
    mimetype: file.mimetype ?? response.mimetype,
    size: file.size ?? response.size,
    path: file.path ?? response.path,
    storageId: file.storageId ?? response.storageId,
    storageType: file.storageType ?? response.storageType ?? file.storage?.type ?? response.storage?.type,
    storageName: file.storageName ?? response.storageName ?? file.storage?.name ?? response.storage?.name,
    storage: file.storage ?? response.storage,
    collectionName: file.collectionName ?? response.collectionName,
    lastModified: file.lastModified ?? response.lastModified,
  };
}

const getFileExt = (file: any): string => {
  const record = getPreviewFileRecord(file);
  const value =
    typeof record === 'string' ? record : record?.extname || record?.name || record?.filename || record?.url || '';
  const clean = value.split('?')[0].split('#')[0];
  const index = clean.lastIndexOf('.');
  return index !== -1
    ? clean
        .slice(index + 1)
        .toLowerCase()
        .replace(/^\./, '')
    : '';
};

const resolveFileUrl = (file: any): string => {
  const record = getPreviewFileRecord(file);
  const url = typeof record === 'string' ? record : record?.url || record?.preview || record?.path;
  if (!url) {
    return '';
  }
  return url.startsWith('https://') || url.startsWith('http://') ? url : `${location.origin}/${url.replace(/^\//, '')}`;
};

const getFileDependencyKey = (file: any): string => {
  if (typeof file === 'string') return file;
  const record = getPreviewFileRecord(file);
  if (!record) return '';
  return [
    record.id,
    record.uid,
    record.url,
    record.preview,
    record.path,
    record.storageId,
    record.storageType,
    record.storageName,
    record.collectionName,
    record.lastModified,
    record.size,
  ]
    .filter((value) => value != null && value !== '')
    .join(':');
};

const isPdfFile = (file: any): boolean => {
  const record = getPreviewFileRecord(file);
  if (record?.mimetype && PDF_MIME_TYPES.includes(record.mimetype)) return true;
  const ext = getFileExt(file);
  return !!ext && PDF_EXTS.includes(ext);
};

const isImageFile = (file: any): boolean => {
  const record = getPreviewFileRecord(file);
  if (record?.mimetype && IMAGE_MIME_TYPES.includes(record.mimetype)) return true;
  if (record?.mimetype && matchMimetype(record, 'image/*')) return true;
  const ext = getFileExt(file);
  return !!ext && IMAGE_EXTS.includes(ext);
};

const isTextFile = (file: any): boolean => {
  const record = getPreviewFileRecord(file);
  if (record?.mimetype && TEXT_MIME_TYPES.includes(record.mimetype)) return true;
  const ext = getFileExt(file);
  return !!ext && TEXT_EXTS.includes(ext);
};

const isDocxFile = (file: any): boolean => {
  const record = getPreviewFileRecord(file);
  if (record?.mimetype && DOCX_MIME_TYPES.includes(record.mimetype)) return true;
  const ext = getFileExt(file);
  return !!ext && DOCX_EXTS.includes(ext);
};

const isXlsxFile = (file: any): boolean => {
  const record = getPreviewFileRecord(file);
  if (record?.mimetype && XLSX_MIME_TYPES.includes(record.mimetype)) return true;
  const ext = getFileExt(file);
  return !!ext && XLSX_EXTS.includes(ext);
};

const isPptxFile = (file: any): boolean => {
  const record = getPreviewFileRecord(file);
  if (record?.mimetype && PPTX_MIME_TYPES.includes(record.mimetype)) return true;
  const ext = getFileExt(file);
  return !!ext && PPTX_EXTS.includes(ext);
};

const isPreviewableFile = (file: any): boolean => {
  return (
    isPdfFile(file) || isImageFile(file) || isTextFile(file) || isDocxFile(file) || isXlsxFile(file) || isPptxFile(file)
  );
};

const getFileDisplayName = (file: any): string => {
  const record = getPreviewFileRecord(file);
  if (!record) return 'download';
  if (record.title && record.extname) return `${record.title}${record.extname}`;
  return record.filename || record.name || record.title || 'download';
};

const loadedBlobCache = new Map<string, Promise<Blob>>();

function getBlobCacheKey(file: any, token: string, downloadUrl: string): string {
  return `${token ? 'auth' : 'anon'}:${token || ''}:${getFileDependencyKey(file) || downloadUrl}`;
}

function normalizeFileForServer(file: any) {
  const record = getPreviewFileRecord(file);
  return {
    id: record?.id,
    uid: record?.uid,
    url: record?.url,
    preview: record?.preview,
    filename: record?.filename || record?.name,
    name: record?.name || record?.filename,
    title: record?.title,
    extname: record?.extname,
    mimetype: record?.mimetype,
    size: record?.size,
    path: record?.path,
    storageId: record?.storageId ?? record?.storage_id ?? record?.storage?.id,
    storage_id: record?.storage_id,
    storageType: record?.storageType || record?.storage?.type,
    storageName: record?.storageName || record?.storage?.name,
    storage: record?.storage,
    collectionName: record?.collectionName,
    lastModified: record?.lastModified,
  };
}

function isInternalAuthenticatedDownloadUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url, location.origin);
    if (parsed.origin !== location.origin) {
      return false;
    }
    return [
      '/api/filePreviewAuth:download',
      '/api/extStorage:download',
      '/api/skillHub:download',
      '/api/worker-monitor',
      '/api/carboneTemplates:download',
      '/api/attachments:stream',
      '/api/attachments:sftpStream',
    ].some(
      (path) =>
        parsed.pathname === path || parsed.pathname.startsWith(`${path}/`) || parsed.pathname.startsWith(`${path}:`),
    );
  } catch {
    return false;
  }
}

function getPublicAssetUrl(path: string): string {
  const publicPath =
    typeof window === 'undefined'
      ? '/'
      : window['__nocobase_dev_public_path__'] || window['__nocobase_public_path__'] || '/';
  return `${publicPath.replace(/\/?$/, '/')}${path.replace(/^\//, '')}`;
}

function getImageThumbnailPlaceholderUrl(file: any): string {
  const record = getPreviewFileRecord(file);
  const ext = getFileExt(record);
  const mimetype = typeof record?.mimetype === 'string' ? record.mimetype.toLowerCase() : '';
  const icon = IMAGE_PLACEHOLDER_ICON_MAP[ext] || MIME_IMAGE_PLACEHOLDER_ICON_MAP[mimetype] || 'unknown-200-200.png';
  return getPublicAssetUrl(`file-placeholder/${icon}`);
}

function getSafeImageThumbnailUrl(file: any): string {
  const record = getPreviewFileRecord(file);
  const thumbnailUrl = [record?.preview, record?.url].find((url) => typeof url === 'string' && url);
  if (thumbnailUrl && !isInternalAuthenticatedDownloadUrl(thumbnailUrl)) {
    return thumbnailUrl;
  }
  return getImageThumbnailPlaceholderUrl(record);
}

function isS3PrivateFile(file: any): boolean {
  const normalized = normalizeFileForServer(typeof file === 'string' ? { url: file } : file || {});
  const storageType = normalized.storageType || normalized.storage?.type;
  return storageType === 's3-private' || storageType === 'aws-s3-private';
}

function isAttachmentStreamCandidate(file: any, sourceUrl: string): boolean {
  const normalized = normalizeFileForServer(typeof file === 'string' ? { url: file } : file || {});
  const collection = normalized.collectionName || 'attachments';
  const id = normalized.id || normalized.uid;
  if (id == null) {
    return false;
  }

  if (isS3PrivateFile(file)) {
    return true;
  }

  return collection === 'attachments' && !sourceUrl;
}

function buildAttachmentStreamUrl(file: any, mode: 'inline' | 'attachment'): string {
  const normalized = normalizeFileForServer(typeof file === 'string' ? { url: file } : file || {});
  const id = normalized.id || normalized.uid;
  if (id == null) {
    return '';
  }

  const params = new URLSearchParams({
    filterByTk: String(id),
    mode,
    collection: normalized.collectionName || 'attachments',
  });
  return `/api/attachments:stream?${params.toString()}`;
}

function buildAuthenticatedDownloadUrl(file: any, mode: 'inline' | 'attachment' = 'inline'): string {
  const normalized = normalizeFileForServer(typeof file === 'string' ? { url: file } : file || {});
  const sourceUrl = resolveFileUrl(file);
  if (sourceUrl && isInternalAuthenticatedDownloadUrl(sourceUrl)) {
    return sourceUrl;
  }

  if (isAttachmentStreamCandidate(file, sourceUrl)) {
    return buildAttachmentStreamUrl(file, mode);
  }

  const id = normalized.id || normalized.uid;
  if (id != null) {
    const collection = normalized.collectionName || 'attachments';
    const params = new URLSearchParams();
    params.set('id', String(id));
    params.set('collection', collection);
    if (sourceUrl) {
      params.set('url', sourceUrl);
    }
    const storageId = normalized.storageId || normalized.storage_id || normalized.storage?.id;
    if (storageId != null && storageId !== '') {
      params.set('storageId', String(storageId));
    }
    if (normalized.filename || normalized.name) {
      params.set('filename', normalized.filename || normalized.name);
    }
    if (normalized.mimetype) {
      params.set('mimetype', normalized.mimetype);
    }
    return `/api/filePreviewAuth:download?${params.toString()}`;
  }

  return sourceUrl || '';
}

// ─── fetchFileAsBlob: fetch with Bearer auth ────────────────────────

async function fetchFileAsBlob(url: string, token: string): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const response = await fetch(url, {
    method: 'GET',
    headers,
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch file: ${response.status} ${response.statusText}`);
  }
  return response.blob();
}

async function getLoadedFileBlob(file: any, token: string, mode: 'inline' | 'attachment' = 'inline'): Promise<Blob> {
  const downloadUrl = buildAuthenticatedDownloadUrl(file, mode);
  if (!downloadUrl || downloadUrl.endsWith('?')) {
    throw new Error('No file URL');
  }
  const cacheKey = getBlobCacheKey(file, token, downloadUrl);
  let pending = loadedBlobCache.get(cacheKey);
  if (!pending) {
    pending = fetchFileAsBlob(downloadUrl, token).catch((err) => {
      loadedBlobCache.delete(cacheKey);
      throw err;
    });
    loadedBlobCache.set(cacheKey, pending);
  }
  return pending;
}

// ─── Authenticated download helper ─────────────────────────────────

async function downloadFileWithAuth(file: any, token: string): Promise<void> {
  const blob = await getLoadedFileBlob(file, token, 'attachment');
  const fileName = getFileDisplayName(file);
  const a = document.createElement('a');
  const objectUrl = URL.createObjectURL(blob);
  a.href = objectUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Small delay before revoking to ensure download starts
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

// ─── useBlobUrl hook ────────────────────────────────────────────────

function useBlobUrl(file: any, token: string) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const fileRef = useRef(file);
  fileRef.current = file;
  const fileDependencyKey = getFileDependencyKey(file);

  useEffect(() => {
    let cancelled = false;
    const currentFile = fileRef.current;
    const hasSource = !!(
      resolveFileUrl(currentFile) ||
      (typeof currentFile !== 'string' && (currentFile?.id || currentFile?.uid))
    );
    if (!hasSource) {
      setLoading(false);
      setError('No file URL');
      return;
    }

    setLoading(true);
    setError(null);

    getLoadedFileBlob(currentFile, token)
      .then((blob) => {
        if (cancelled) return;
        const objectUrl = URL.createObjectURL(blob);
        blobUrlRef.current = objectUrl;
        setBlobUrl(objectUrl);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || 'Failed to load');
        setLoading(false);
      });

    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [fileDependencyKey, token]);

  return { blobUrl, loading, error };
}

// ─── useTextContent hook ────────────────────────────────────────────

function useTextContent(file: any, token: string) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef(file);
  fileRef.current = file;
  const fileDependencyKey = getFileDependencyKey(file);

  useEffect(() => {
    let cancelled = false;
    const currentFile = fileRef.current;
    const hasSource = !!(
      resolveFileUrl(currentFile) ||
      (typeof currentFile !== 'string' && (currentFile?.id || currentFile?.uid))
    );
    if (!hasSource) {
      setLoading(false);
      setError('No file URL');
      return;
    }

    setLoading(true);
    setError(null);

    getLoadedFileBlob(currentFile, token)
      .then((blob) => blob.text())
      .then((content) => {
        if (cancelled) return;
        setText(content);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || 'Failed to load');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fileDependencyKey, token]);

  return { text, loading, error };
}

// ─── Loading / Error shared components ──────────────────────────────

function LoadingIndicator({ message: msg }: { message: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', width: '100%' }}>
      <Spin tip={msg} />
    </div>
  );
}

function ErrorMessage({ message: msg }: { message: string }) {
  return <div style={{ padding: 20, textAlign: 'center', color: '#ff4d4f' }}>{msg}</div>;
}

function PreviewModalTitle({
  file,
  title,
  ocrStatus,
  isOcrSupported,
}: {
  file: any;
  title: string;
  ocrStatus?: string;
  isOcrSupported?: boolean;
}) {
  const t = useT();
  const renderOcrTag = () => {
    if (!isOcrSupported || !ocrStatus) return null;
    switch (ocrStatus) {
      case 'pending-ocr':
        return (
          <Tag color="processing" icon={<SyncOutlined spin />}>
            {t('OCR Pending')}
          </Tag>
        );
      case 'waiting-verify':
        return (
          <Tag color="warning" icon={<ClockCircleOutlined />}>
            {t('Waiting Verify')}
          </Tag>
        );
      case 'verified':
      case 'accepted':
        return (
          <Tag color="success" icon={<CheckCircleOutlined />}>
            {t('OCR Verified')}
          </Tag>
        );
      case 'rejected':
        return <Tag color="error">{t('OCR Rejected')}</Tag>;
      case 'failed':
        return <Tag color="error">{t('OCR Failed')}</Tag>;
      case 'no-ocr':
      default:
        return <Tag color="default">{t('No OCR')}</Tag>;
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingRight: 40 }}>
      <Space size={8} style={{ minWidth: 0, overflow: 'hidden' }}>
        <span
          style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}
          title={title}
        >
          {title}
        </span>
        {renderOcrTag()}
      </Space>
      <AIFilePreviewAction file={file} />
    </div>
  );
}

// ─── Inline Previewers (used inside modals) ─────────────────────────

function AuthPdfInlinePreviewer({ file }: any) {
  const apiClient = useAPIClient();
  const t = useT();
  const token = apiClient.auth?.token || '';
  const { blobUrl, loading, error } = useBlobUrl(file, token);

  if (loading) return <LoadingIndicator message={t('Loading preview...')} />;
  if (error || !blobUrl) return <ErrorMessage message={t('Failed to load file preview')} />;
  return <iframe src={blobUrl} width="100%" height="100%" style={{ border: 'none' }} />;
}

function AuthImageInlinePreviewer({ file }: any) {
  const apiClient = useAPIClient();
  const t = useT();
  const token = apiClient.auth?.token || '';
  const { blobUrl, loading, error } = useBlobUrl(file, token);

  if (loading) return <LoadingIndicator message={t('Loading preview...')} />;
  if (error || !blobUrl) return <ErrorMessage message={t('Failed to load file preview')} />;
  return (
    <img
      src={blobUrl}
      style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
      alt={file?.title || file?.filename || ''}
    />
  );
}

function AuthTextInlinePreviewer({ file }: any) {
  const apiClient = useAPIClient();
  const t = useT();
  const token = apiClient.auth?.token || '';
  const { text, loading, error } = useTextContent(file, token);

  if (loading) return <LoadingIndicator message={t('Loading preview...')} />;
  if (error || text === null) return <ErrorMessage message={t('Failed to load file preview')} />;
  return (
    <pre
      style={{
        width: '100%',
        height: '100%',
        overflow: 'auto',
        padding: 16,
        margin: 0,
        fontSize: 13,
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
        wordWrap: 'break-word',
        background: '#f5f5f5',
        border: 'none',
      }}
    >
      {text}
    </pre>
  );
}

function AuthDocxInlinePreviewer({ file }: any) {
  const apiClient = useAPIClient();
  const t = useT();
  const token = apiClient.auth?.token || '';
  const containerRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef(file);
  fileRef.current = file;
  const fileDependencyKey = getFileDependencyKey(file);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const currentFile = fileRef.current;
    const hasSource = !!(
      resolveFileUrl(currentFile) ||
      (typeof currentFile !== 'string' && (currentFile?.id || currentFile?.uid))
    );
    if (!hasSource || !containerRef.current) {
      setLoading(false);
      setError('No file URL');
      return;
    }

    setLoading(true);
    setError(null);

    (async () => {
      try {
        const blob = await getLoadedFileBlob(currentFile, token);
        if (cancelled) return;
        // Dynamic import for code-splitting (bundled, no CDN needed)
        // @ts-ignore
        const docxPreview = await import('docx-preview');
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = '';
        await docxPreview.renderAsync(blob, containerRef.current, undefined, {
          className: 'docx-preview-wrapper',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          experimental: false,
          trimXmlDeclaration: true,
          useBase64URL: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
        });
        setLoading(false);
      } catch (err: any) {
        if (cancelled) return;
        setError(err.message || 'Failed to render DOCX');
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fileDependencyKey, token]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {loading && <LoadingIndicator message={t('Loading preview...')} />}
      {error && <ErrorMessage message={t('Failed to load file preview')} />}
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          overflow: 'auto',
          display: loading || error ? 'none' : 'block',
        }}
      />
    </div>
  );
}

function AuthXlsxInlinePreviewer({ file }: any) {
  const apiClient = useAPIClient();
  const t = useT();
  const token = apiClient.auth?.token || '';
  const containerRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef(file);
  fileRef.current = file;
  const fileDependencyKey = getFileDependencyKey(file);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState<string>('');
  const [sheetsHtml, setSheetsHtml] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const currentFile = fileRef.current;
    const hasSource = !!(
      resolveFileUrl(currentFile) ||
      (typeof currentFile !== 'string' && (currentFile?.id || currentFile?.uid))
    );
    if (!hasSource) {
      setLoading(false);
      setError('No file URL');
      return;
    }

    setLoading(true);
    setError(null);

    (async () => {
      try {
        const blob = await getLoadedFileBlob(currentFile, token);
        if (cancelled) return;
        // Dynamic import for code-splitting (bundled, no CDN needed)
        // @ts-ignore
        const XLSX = await import('xlsx');
        if (cancelled) return;
        const arrayBuffer = await blob.arrayBuffer();
        if (cancelled) return;
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });
        const names = workbook.SheetNames as string[];
        const htmlMap: Record<string, string> = {};
        for (const name of names) {
          const sheet = workbook.Sheets[name];
          htmlMap[name] = XLSX.utils.sheet_to_html(sheet, { id: 'xlsx-preview-table' });
        }
        if (cancelled) return;
        setSheetNames(names);
        setActiveSheet(names[0] || '');
        setSheetsHtml(htmlMap);
        setLoading(false);
      } catch (err: any) {
        if (cancelled) return;
        setError(err.message || 'Failed to render XLSX');
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fileDependencyKey, token]);

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {loading && <LoadingIndicator message={t('Loading preview...')} />}
      {error && <ErrorMessage message={t('Failed to load file preview')} />}
      {!loading && !error && (
        <>
          {sheetNames.length > 1 && (
            <div
              style={{
                display: 'flex',
                gap: 0,
                borderBottom: '1px solid #e8e8e8',
                background: '#fafafa',
                padding: '0 8px',
                flexShrink: 0,
                overflowX: 'auto',
              }}
            >
              {sheetNames.map((name) => (
                <button
                  key={name}
                  onClick={() => setActiveSheet(name)}
                  style={{
                    padding: '8px 16px',
                    border: 'none',
                    borderBottom: activeSheet === name ? '2px solid #1890ff' : '2px solid transparent',
                    background: activeSheet === name ? '#fff' : 'transparent',
                    color: activeSheet === name ? '#1890ff' : '#666',
                    fontWeight: activeSheet === name ? 600 : 400,
                    cursor: 'pointer',
                    fontSize: 13,
                    whiteSpace: 'nowrap',
                    transition: 'all 0.2s',
                  }}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
          <div
            ref={containerRef}
            style={{ flex: 1, overflow: 'auto', padding: 0 }}
            dangerouslySetInnerHTML={{ __html: sheetsHtml[activeSheet] || '' }}
          />
          <style>{`
            #xlsx-preview-table {
              border-collapse: collapse;
              width: 100%;
              font-size: 13px;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
            #xlsx-preview-table td,
            #xlsx-preview-table th {
              border: 1px solid #e8e8e8;
              padding: 6px 10px;
              text-align: left;
              max-width: 33vw;
              white-space: normal;
              word-break: break-word;
            }
            #xlsx-preview-table tr:first-child td,
            #xlsx-preview-table tr:first-child th {
              background: #fafafa;
              font-weight: 600;
              position: sticky;
              top: 0;
              z-index: 1;
            }
            #xlsx-preview-table tr:nth-child(even) {
              background: #fafafa;
            }
            #xlsx-preview-table tr:hover {
              background: #f0f7ff;
            }
          `}</style>
        </>
      )}
    </div>
  );
}

function AuthPptxInlinePreviewer({ file }: any) {
  const apiClient = useAPIClient();
  const t = useT();
  const token = apiClient.auth?.token || '';
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileBlob, setFileBlob] = useState<Blob | null>(null);
  const [PptxPreviewer, setPptxPreviewer] = useState<any>(null);
  const fileRef = useRef(file);
  fileRef.current = file;
  const fileDependencyKey = getFileDependencyKey(file);

  useEffect(() => {
    let cancelled = false;
    const currentFile = fileRef.current;
    const hasSource = !!(
      resolveFileUrl(currentFile) ||
      (typeof currentFile !== 'string' && (currentFile?.id || currentFile?.uid))
    );
    if (!hasSource) {
      setLoading(false);
      setError('No file URL');
      return;
    }

    setLoading(true);
    setError(null);

    (async () => {
      try {
        const [blob, module] = await Promise.all([
          getLoadedFileBlob(currentFile, token),
          // @ts-ignore
          import('react-pptx-preview-kit'),
        ]);
        if (cancelled) return;
        setFileBlob(blob);
        setPptxPreviewer(() => module.PptxPreview);
        setLoading(false);
      } catch (err: any) {
        if (cancelled) return;
        setError(err.message || 'Failed to render PPTX');
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fileDependencyKey, token]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {loading && <LoadingIndicator message={t('Loading preview...')} />}
      {error && <ErrorMessage message={t('Failed to load file preview')} />}
      {!loading && !error && PptxPreviewer && (
        <div style={{ width: '100%', height: '100%', overflow: 'auto' }}>
          <PptxPreviewer file={fileBlob} />
        </div>
      )}
    </div>
  );
}

// ─── wrapWithAuthModalPreviewer ─────────────────────────────────────
// Custom wrapper that replaces the original wrapWithModalPreviewer.
// The key difference: it OVERRIDES the onDownload prop from parent
// components (DisplayPreviewFieldModel, UploadFieldModel) which use
// fetch(url) without auth — replacing it with our authenticated version.

const wrapWithAuthModalPreviewer = (Previewer: React.ComponentType<any>) => {
  return function AuthWrappedPreviewer(props: any) {
    const { open, onOpenChange, onClose, file, index, list, onSwitchIndex, onDownload: _originalOnDownload } = props;
    const apiClient = useAPIClient();
    const t = useT();
    const [previewMode, setPreviewMode] = useState<'visual' | 'raw'>('visual');

    // Override onDownload with authenticated version
    const authOnDownload = useCallback(
      async (fileOverride?: any) => {
        const target = fileOverride || file;
        if (!target) return;
        const token = apiClient.auth?.token || '';
        try {
          await downloadFileWithAuth(target, token);
        } catch (err) {
          message.error(t('Failed to download file'));
        }
      },
      [file, apiClient, t],
    );

    if (typeof open !== 'boolean') {
      return <Previewer {...props} onDownload={authOnDownload} />;
    }

    const title = getFileDisplayName(file);
    const canPrev = typeof index === 'number' && !!onSwitchIndex && index > 0;
    const canNext = typeof index === 'number' && !!onSwitchIndex && index < list.length - 1;

    return (
      <Modal
        open={open}
        title={<PreviewModalTitle file={file} title={title} />}
        onCancel={() => {
          onOpenChange?.(false);
          onClose?.();
          setPreviewMode('visual');
        }}
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <div key="left-actions">
              <Button onClick={() => setPreviewMode((prev) => (prev === 'visual' ? 'raw' : 'visual'))}>
                {previewMode === 'visual' ? t('View Raw Parsed Text') : t('View Visual Preview')}
              </Button>
            </div>
            <Space size={14} style={{ fontSize: '20px' }}>
              <LeftOutlined
                style={{ cursor: canPrev ? 'pointer' : 'not-allowed' }}
                onClick={() => canPrev && onSwitchIndex?.(index - 1)}
              />
              <RightOutlined
                style={{ cursor: canNext ? 'pointer' : 'not-allowed' }}
                onClick={() => canNext && onSwitchIndex?.(index + 1)}
              />
              <DownloadOutlined onClick={() => authOnDownload(file)} />
            </Space>
          </div>
        }
        width="90%"
        centered={true}
      >
        <div
          style={{
            maxWidth: '100%',
            maxHeight: 'calc(100vh - 256px)',
            height: '80vh',
            width: '100%',
            background: 'white',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            overflowY: 'auto',
          }}
        >
          {previewMode === 'raw' ? (
            <AuthRawTextPreviewer file={file} />
          ) : (
            <Previewer {...props} onDownload={authOnDownload} />
          )}
        </div>
      </Modal>
    );
  };
};

function AuthRawTextPreviewer({ file }: any) {
  const apiClient = useAPIClient();
  const t = useT();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Use NocoBase's Markdown renderer if available (e.g. from plugin-field-markdown-vditor)
  const MarkdownVditor = useComponent('MarkdownVditor');
  const MarkdownVoid = useComponent('Markdown.Void');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const token = apiClient.auth?.token || '';
        const blob = await getLoadedFileBlob(file, token);
        if (cancelled) return;

        const formData = new FormData();
        formData.append('file', blob, getFileDisplayName(file));
        formData.append('attachment', JSON.stringify(normalizeFileForServer(file)));

        const response = await apiClient.request({
          url: 'filePreviewAuth:getContent',
          method: 'post',
          data: formData,
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        if (cancelled) return;
        const text = response?.data?.data?.content || '';

        // The server wraps content in <file_preview> XML tags, let's strip it for a cleaner raw text view
        let cleanText = text;
        const match = text.match(/<file_preview[^>]*>([\s\S]*?)<\/file_preview>/i);
        if (match) {
          cleanText = match[1].trim();
        }

        setContent(cleanText);
        setLoading(false);
      } catch (err: any) {
        if (cancelled) return;
        setError(err.message || 'Failed to fetch raw text');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, apiClient]);

  if (loading) return <Spin size="large" tip={t('Extracting raw text...')} style={{ marginTop: '40px' }} />;
  if (error) return <Alert type="error" message={error} style={{ width: '100%', margin: '20px' }} />;

  if (!content) {
    return (
      <Alert
        type="info"
        style={{ width: '100%', margin: '20px' }}
        description={t('No text content could be extracted from this file.')}
        showIcon
      />
    );
  }

  const handleCopy = () => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(content)
        .then(() => {
          message.success(t('Copied to clipboard'));
        })
        .catch((err) => {
          message.error(t('Failed to copy'));
          console.error('Copy error', err);
        });
    } else {
      // Fallback
      const textArea = document.createElement('textarea');
      textArea.value = content;
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        message.success(t('Copied to clipboard'));
      } catch (err) {
        message.error(t('Failed to copy'));
      }
      document.body.removeChild(textArea);
    }
  };

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <span
        onClick={handleCopy}
        style={{
          position: 'absolute',
          top: '20px',
          right: '25px',
          zIndex: 10,
          cursor: 'pointer',
          padding: '4px 10px',
          background: 'rgba(255, 255, 255, 0.85)',
          border: '1px solid #e8e8e8',
          borderRadius: '4px',
          color: '#1890ff',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
          fontSize: '13px',
        }}
        title={t('Copy')}
      >
        <CopyOutlined />
        {t('Copy')}
      </span>
      <div style={{ flex: 1, overflow: 'auto', padding: '20px', textAlign: 'left' }}>
        <style>
          {`
            .hide-vditor-toolbar .vditor-toolbar {
              display: none !important;
            }
            .hide-vditor-toolbar .vditor {
              border: none !important;
            }
          `}
        </style>
        <div className="hide-vditor-toolbar" style={{ height: '100%' }}>
          {MarkdownVditor ? (
            <MarkdownVditor value={content} disabled={false} />
          ) : MarkdownVoid ? (
            <MarkdownVoid content={content} />
          ) : (
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace', fontSize: '13px' }}>
              {content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Catch-all Modal Previewer (for attachmentFileTypes) ────────────
// Intercepts ALL file clicks in Upload/Attachment components and provides:
// - Authenticated preview for PDF/image/text
// - Authenticated download for ALL files (including non-previewable)

function AuthCatchAllModalPreviewer({ index, list, onSwitchIndex }: any) {
  const t = useT();
  const apiClient = useAPIClient();
  const file = list[index];
  const [downloading, setDownloading] = useState(false);
  const [previewMode, setPreviewMode] = useState<'visual' | 'raw'>('visual');
  const [activeTab, setActiveTab] = useState<'preview' | 'ocr'>('preview');

  // OCR state
  const [ocrStatus, setOcrStatus] = useState<string>('no-ocr');
  const [ocrResultId, setOcrResultId] = useState<string | number | null>(null);
  const [ocrError, setOcrError] = useState<string | null>(null);

  const isOcrSupported = useMemo(() => {
    if (!file) return false;
    return isPdfFile(file) || isImageFile(file);
  }, [file]);

  const OcrVerifyBlock = useComponent('OcrVerifyBlock');

  const loadOcrStatus = useCallback(async () => {
    if (!file?.id) return null;
    const res = await apiClient.request({
      url: 'filePreviewAuth:getOcrStatus',
      method: 'post',
      data: {
        attachmentId: file.id,
      },
    });
    const record = res?.data?.data;
    if (record) {
      setOcrResultId(record.id || null);
      setOcrStatus(record.status || 'no-ocr');
      setOcrError(record.error || null);
    }
    return record;
  }, [apiClient, file?.id]);

  // Load / Sync initial OCR status from the separate OCR result collection.
  useEffect(() => {
    if (!file?.id) return;
    let cancelled = false;
    setOcrResultId(null);
    setOcrStatus('no-ocr');
    setOcrError(null);

    loadOcrStatus()
      .then(() => {
        if (cancelled) return;
      })
      .catch(console.error);

    return () => {
      cancelled = true;
    };
  }, [file?.id, loadOcrStatus]);

  // Polling for OCR job completion when ocrStatus is 'pending-ocr'
  useEffect(() => {
    if (ocrStatus !== 'pending-ocr' || !file?.id) return;
    let timer: any = null;
    let cancelled = false;

    const poll = async () => {
      try {
        const record = await loadOcrStatus();
        if (cancelled) return;
        if (record) {
          if (record.status !== 'pending-ocr') {
            if (record.status === 'failed') {
              message.error(record.error || t('OCR processing failed'));
            } else {
              message.success(t('OCR processing completed!'));
            }
          } else {
            timer = setTimeout(poll, 3000);
          }
        }
      } catch (err) {
        console.error('Polling error', err);
        timer = setTimeout(poll, 3000);
      }
    };

    timer = setTimeout(poll, 3000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [ocrStatus, file?.id, loadOcrStatus, t]);

  const handleRunOcr = async () => {
    if (!file?.id) return;
    try {
      setOcrStatus('pending-ocr');
      const res = await apiClient.request({
        url: 'filePreviewAuth:runOcr',
        method: 'post',
        data: {
          attachmentId: file.id,
        },
      });
      const record = res?.data?.data;
      if (record) {
        setOcrResultId(record.id || null);
        setOcrStatus(record.status || 'pending-ocr');
        setOcrError(record.error || null);
      }
      message.info(t('OCR process started in the background.'));
    } catch (err: any) {
      message.error(err?.message || t('Failed to start OCR process.'));
      setOcrStatus('no-ocr');
    }
  };

  const onDownload = useCallback(
    async (e: any) => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      const token = apiClient.auth?.token || '';
      setDownloading(true);
      try {
        await downloadFileWithAuth(file, token);
      } catch (err) {
        message.error(t('Failed to download file'));
      } finally {
        setDownloading(false);
      }
    },
    [file, apiClient, t],
  );

  const onClose = useCallback(() => {
    onSwitchIndex(null);
    setPreviewMode('visual');
    setActiveTab('preview');
  }, [onSwitchIndex]);

  // Determine which inline previewer to use (null for non-previewable)
  const PreviewerComponent = useMemo(() => {
    if (isPdfFile(file)) return AuthPdfInlinePreviewer;
    if (isImageFile(file)) return AuthImageInlinePreviewer;
    if (isTextFile(file)) return AuthTextInlinePreviewer;
    if (isDocxFile(file)) return AuthDocxInlinePreviewer;
    if (isXlsxFile(file)) return AuthXlsxInlinePreviewer;
    if (isPptxFile(file)) return AuthPptxInlinePreviewer;
    return null;
  }, [file]);

  const canPreview = PreviewerComponent != null || previewMode === 'raw';

  const tabItems = [
    {
      key: 'preview',
      label: (
        <span>
          <EyeOutlined /> {t('Visual Preview')}
        </span>
      ),
      children: (
        <div
          style={{
            height: '70vh',
            width: '100%',
            overflow: 'auto',
            background: '#f5f5f5',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          {PreviewerComponent ? <PreviewerComponent file={file} /> : null}
        </div>
      ),
    },
    {
      key: 'ocr',
      label: (
        <span>
          <ScanOutlined /> {t('OCR & Verify')}
        </span>
      ),
      children: (
        <div style={{ height: '70vh', width: '100%', display: 'flex', flexDirection: 'column' }}>
          {ocrStatus === 'no-ocr' && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: 'center',
                height: '100%',
                padding: '40px',
                background: '#fafafa',
                borderRadius: '8px',
              }}
            >
              <ScanOutlined style={{ fontSize: '64px', color: '#1890ff', marginBottom: '20px' }} />
              <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '10px' }}>
                {t('Word-level Song ngữ (English & Vietnamese) OCR')}
              </h3>
              <p style={{ color: '#8c8c8c', maxWidth: '480px', textAlign: 'center', marginBottom: '24px' }}>
                {t(
                  'Chưa có dữ liệu OCR cấp độ Từ (Word-level) cho tệp này. Hãy chạy nhận dạng Tesseract-OCR để bắt đầu đối soát và verify toạ độ.',
                )}
              </p>
              <Button type="primary" size="large" icon={<ThunderboltOutlined />} onClick={handleRunOcr}>
                {t('Run Tesseract OCR')}
              </Button>
            </div>
          )}
          {ocrStatus === 'pending-ocr' && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: 'center',
                height: '100%',
                padding: '40px',
              }}
            >
              <Spin size="large" tip={t('Analyzing layout structure and running song ngữ OCR...')} />
              <p style={{ color: '#8c8c8c', marginTop: '20px', fontSize: '13px', textAlign: 'center' }}>
                {t(
                  'Extracting word-level coordinates via Tesseract-OCR. This will automatically refresh when complete.',
                )}
              </p>
            </div>
          )}
          {ocrStatus === 'failed' && (
            <div style={{ padding: '40px' }}>
              <Alert
                type="error"
                showIcon
                message={t('OCR processing failed')}
                description={ocrError || t('Please try running OCR again.')}
                style={{ marginBottom: 24 }}
              />
              <Button type="primary" icon={<ThunderboltOutlined />} onClick={handleRunOcr}>
                {t('Run Tesseract OCR')}
              </Button>
            </div>
          )}
          {['waiting-verify', 'verified', 'accepted', 'rejected'].includes(ocrStatus) && (
            <div style={{ flex: 1, height: '100%', overflow: 'hidden' }}>
              {OcrVerifyBlock && ocrResultId ? (
                <OcrVerifyBlock
                  collection="attachmentOcrResults"
                  recordId={ocrResultId}
                  pdfField="attachment"
                  jsonField="data"
                  statusField="status"
                />
              ) : OcrVerifyBlock ? (
                <div style={{ padding: '20px' }}>
                  <Alert
                    type="error"
                    message={t('OCR result record not found')}
                    description={t('Please try running OCR again.')}
                    showIcon
                  />
                </div>
              ) : (
                <div style={{ padding: '20px' }}>
                  <Alert
                    type="error"
                    message={t('Plugin OCR Verify Block is not enabled')}
                    description={t(
                      'Please enable the plugin-ocr-verify-block plugin to display the verify splitter layout.',
                    )}
                    showIcon
                  />
                </div>
              )}
            </div>
          )}
        </div>
      ),
    },
  ];

  return (
    <Modal
      open={index != null}
      title={
        <PreviewModalTitle
          file={file}
          title={file?.title || file?.filename || file?.name || 'File'}
          ocrStatus={ocrStatus}
          isOcrSupported={isOcrSupported}
        />
      }
      onCancel={onClose}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
          <div key="left-actions">
            {!isOcrSupported && (
              <Button onClick={() => setPreviewMode((prev) => (prev === 'visual' ? 'raw' : 'visual'))}>
                {previewMode === 'visual' ? t('View Raw Parsed Text') : t('View Visual Preview')}
              </Button>
            )}
          </div>
          <Space>
            <Button key="download" onClick={onDownload} loading={downloading}>
              {t('Download')}
            </Button>
            <Button key="close" onClick={onClose}>
              {t('Close')}
            </Button>
          </Space>
        </div>
      }
      width={canPreview ? '90%' : 520}
      centered={true}
    >
      {isOcrSupported ? (
        <Tabs
          activeKey={activeTab}
          onChange={(key: any) => setActiveTab(key)}
          items={tabItems}
          style={{ width: '100%', height: '100%' }}
        />
      ) : (
        <div
          style={{
            maxWidth: '100%',
            maxHeight: canPreview ? 'calc(100vh - 256px)' : 'auto',
            height: canPreview ? '70vh' : 'auto',
            width: '100%',
            background: 'white',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            overflowY: 'auto',
          }}
        >
          {previewMode === 'raw' ? (
            <AuthRawTextPreviewer file={file} />
          ) : PreviewerComponent ? (
            <PreviewerComponent file={file} />
          ) : (
            <Alert
              type="info"
              style={{ width: '100%' }}
              description={t('This file type cannot be previewed. Click Download to save the file.')}
              showIcon
            />
          )}
        </div>
      )}
    </Modal>
  );
}

// ─── Download-only previewer (for filePreviewTypes non-previewable) ──

function AuthDownloadPreviewer({ file }: any) {
  const apiClient = useAPIClient();
  const t = useT();

  const authDownload = useCallback(async () => {
    const token = apiClient.auth?.token || '';
    try {
      await downloadFileWithAuth(file, token);
    } catch (err) {
      message.error(t('Failed to download file'));
    }
  }, [file, apiClient, t]);

  return (
    <Alert
      type="info"
      style={{ width: '100%' }}
      description={
        <span>
          {t('This file type cannot be previewed. ')}{' '}
          <a onClick={authDownload} style={{ textDecoration: 'underline', cursor: 'pointer' }}>
            {t('Download')}
          </a>
        </span>
      }
      showIcon
    />
  );
}

// ─── Plugin class ───────────────────────────────────────────────────

export class PluginFilePreviewAuthClient extends Plugin {
  async load() {
    this.patchUploadPreviewBase64Fallback();
    registerFilePreviewAIWorkContext(this.app);

    // ────────────────────────────────────────────────────────────────
    // 1) attachmentFileTypes: Catch-ALL handler for Upload/Attachment
    //    This intercepts ALL file clicks (any type) and provides:
    //    - Authenticated preview for PDF/image/text
    //    - Authenticated download for ALL files (including non-previewable)
    // ────────────────────────────────────────────────────────────────
    attachmentFileTypes.add({
      match() {
        return true; // Match ALL files
      },
      Previewer: AuthCatchAllModalPreviewer,
    });

    // ────────────────────────────────────────────────────────────────
    // 2) filePreviewTypes: Handlers for File Manager previews
    //    Uses custom wrapWithAuthModalPreviewer that OVERRIDES the
    //    onDownload prop from parent with authenticated fetch version.
    //    This ensures the download icon (DownloadOutlined) in the
    //    modal footer bar also uses Bearer token authentication.
    // ────────────────────────────────────────────────────────────────

    // Catch-all for non-previewable files (download with auth)
    filePreviewTypes.add({
      match() {
        return true; // Fallback for all files
      },
      Previewer: wrapWithAuthModalPreviewer(AuthDownloadPreviewer),
    });

    // PDF preview
    filePreviewTypes.add({
      match: isPdfFile,
      Previewer: wrapWithAuthModalPreviewer(AuthPdfInlinePreviewer),
    });

    // Image preview
    filePreviewTypes.add({
      match: isImageFile,
      getThumbnailURL(file: any) {
        return getSafeImageThumbnailUrl(file);
      },
      Previewer: wrapWithAuthModalPreviewer(AuthImageInlinePreviewer),
    });

    // Text preview
    filePreviewTypes.add({
      match: isTextFile,
      Previewer: wrapWithAuthModalPreviewer(AuthTextInlinePreviewer),
    });

    // DOCX preview
    filePreviewTypes.add({
      match: isDocxFile,
      Previewer: wrapWithAuthModalPreviewer(AuthDocxInlinePreviewer),
    });

    // XLSX preview
    filePreviewTypes.add({
      match: isXlsxFile,
      Previewer: wrapWithAuthModalPreviewer(AuthXlsxInlinePreviewer),
    });

    // PPTX preview
    filePreviewTypes.add({
      match: isPptxFile,
      Previewer: wrapWithAuthModalPreviewer(AuthPptxInlinePreviewer),
    });
  }

  private patchUploadPreviewBase64Fallback() {
    if (typeof window === 'undefined') {
      return;
    }

    const fileReaderProto = window.FileReader?.prototype as any;
    if (!fileReaderProto || fileReaderProto.__filePreviewAuthBase64FallbackPatched) {
      return;
    }

    const originalReadAsDataURL = fileReaderProto.readAsDataURL;
    if (typeof originalReadAsDataURL !== 'function') {
      return;
    }

    Object.defineProperty(fileReaderProto, '__filePreviewAuthBase64FallbackPatched', {
      value: true,
      configurable: true,
    });

    fileReaderProto.readAsDataURL = function readAsDataURLWithEmptyFallback(blob: Blob | null | undefined) {
      if (blob != null) {
        return originalReadAsDataURL.call(this, blob);
      }

      setTimeout(() => {
        try {
          Object.defineProperty(this, 'result', {
            value: '',
            configurable: true,
          });
        } catch {
          // Ignore readonly result assignment failures; the caller will still continue via onload.
        }

        this.onload?.(new ProgressEvent('load'));
        this.onloadend?.(new ProgressEvent('loadend'));
      }, 0);
    };
  }
}

export default PluginFilePreviewAuthClient;
