/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Button, Spin, Alert, message } from 'antd';
import { DownloadOutlined, DeleteOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { SessionBlobCache } from './SessionBlobCache';
import { AppRamCache } from './ChatFilePreviewProvider';
import { useTranslation } from './locale';

// ─── Supported MIME / extension lists ──────────────────────────────

const PDF_MIME = ['application/pdf'];
const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp'];
const TEXT_MIME = [
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
const DOCX_MIME = ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const XLSX_MIME = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'];

const PDF_EXT = ['pdf'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
const TEXT_EXT = ['txt', 'csv', 'html', 'css', 'js', 'json', 'xml', 'log', 'md', 'yaml', 'yml', 'xaml'];
const DOCX_EXT = ['docx'];
const XLSX_EXT = ['xlsx', 'xls'];

// ─── Utilities ─────────────────────────────────────────────────────

export function getFileExt(file: any): string {
  const value = typeof file === 'string' ? file : file?.extname || file?.name || file?.filename || file?.url || '';
  const clean = value.split('?')[0].split('#')[0];
  const idx = clean.lastIndexOf('.');
  return idx !== -1
    ? clean
        .slice(idx + 1)
        .toLowerCase()
        .replace(/^\./, '')
    : '';
}

export function resolveFileUrl(file: any): string {
  const url = typeof file === 'string' ? file : file?.url;
  if (!url) return '';
  return url.startsWith('http://') || url.startsWith('https://') ? url : `${location.origin}/${url.replace(/^\//, '')}`;
}

function matchType(file: any, mimes: string[], exts: string[]): boolean {
  if (file?.mimetype && mimes.includes(file.mimetype)) return true;
  const ext = getFileExt(file);
  return !!ext && exts.includes(ext);
}

export const isPdfFile = (f: any) => matchType(f, PDF_MIME, PDF_EXT);
export const isImageFile = (f: any) => matchType(f, IMAGE_MIME, IMAGE_EXT);
export const isTextFile = (f: any) => matchType(f, TEXT_MIME, TEXT_EXT);
export const isDocxFile = (f: any) => matchType(f, DOCX_MIME, DOCX_EXT);
export const isXlsxFile = (f: any) => matchType(f, XLSX_MIME, XLSX_EXT);
export const isPreviewableFile = (f: any) => isPdfFile(f) || isImageFile(f) || isTextFile(f) || isDocxFile(f) || isXlsxFile(f);

export function isPreviewableUrl(url: string): boolean {
  return isPreviewableFile({ url });
}

async function fetchFileAsBlob(apiClient: any, url: string): Promise<Blob> {
  const res = await apiClient.axios.get(url, { responseType: 'blob' });
  return res.data;
}

async function resolveFileBlob(file: any, apiClient: any, sessionId: string): Promise<Blob> {
  const fileUrl = resolveFileUrl(file);
  const fileId = String(file?.id || file?.uid || fileUrl);
  const name = file?.filename || file?.name || file?.title;
  
  if (name && AppRamCache.has(name)) {
    return AppRamCache.get(name) as Blob;
  }

  // Also try display name or fallback
  if (file?.title && AppRamCache.has(file.title)) {
    return AppRamCache.get(file.title) as Blob;
  }
  
  if (sessionId && fileId) {
    const sessionBlob = await SessionBlobCache.get(sessionId, fileId).catch(() => null);
    if (sessionBlob) return sessionBlob;
  }
  
  if (!fileUrl) throw new Error('No valid URL');
  const serverBlob = await fetchFileAsBlob(apiClient, fileUrl);
  
  if (sessionId && fileId) {
    SessionBlobCache.put(sessionId, fileId, serverBlob).catch(() => {});
  }
  return serverBlob;
}

// ─── Download helper ───────────────────────────────────────────────

async function downloadFileWithAuth(file: any, apiClient: any) {
  const blob = await resolveFileBlob(file, apiClient, '');
  const name = file?.title && file?.extname ? `${file.title}${file.extname}` : file?.filename || file?.name || 'download';
  const a = document.createElement('a');
  const objectUrl = URL.createObjectURL(blob);
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

// ─── Shared components ─────────────────────────────────────────────

function LoadingIndicator({ msg }: { msg: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', width: '100%' }}>
      <Spin tip={msg} />
    </div>
  );
}

function ErrorMsg({ msg }: { msg: string }) {
  return <div style={{ padding: 20, textAlign: 'center', color: '#ff4d4f' }}>{msg}</div>;
}

// ─── Hook: load blob with session cache ────────────────────────────

function useCachedBlobUrl(file: any, apiClient: any, sessionId: string) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  const fileId = file?.id || file?.uid || '';
  const fileUrl = resolveFileUrl(file);

  useEffect(() => {
    let cancelled = false;
    if (!fileUrl) {
      setLoading(false);
      setError('No file URL');
      return;
    }

    setLoading(true);
    setError(null);

    (async () => {
      try {
        // Check IndexedDB cache first
        if (sessionId && fileId) {
          const cached = await SessionBlobCache.get(sessionId, String(fileId));
          if (cached && !cancelled) {
            const url = URL.createObjectURL(cached);
            blobUrlRef.current = url;
            setBlobUrl(url);
            setLoading(false);
            return;
          }
        }

        // Fetch from server
        const blob = await fetchFileAsBlob(apiClient, fileUrl);
        if (cancelled) return;

        // Cache to IndexedDB
        if (sessionId && fileId) {
          SessionBlobCache.put(sessionId, String(fileId), blob).catch(() => {});
        }

        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setBlobUrl(url);
        setLoading(false);
      } catch (err: any) {
        if (cancelled) return;
        setError(err.message || 'Failed to load');
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [fileUrl, apiClient, sessionId, fileId]);

  return { blobUrl, loading, error };
}

function useCachedTextContent(file: any, apiClient: any, sessionId: string) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fileId = file?.id || file?.uid || '';
  const fileUrl = resolveFileUrl(file);

  useEffect(() => {
    let cancelled = false;
    if (!fileUrl) {
      setLoading(false);
      setError('No file URL');
      return;
    }

    setLoading(true);
    setError(null);

    (async () => {
      try {
        // Check cache
        if (sessionId && fileId) {
          const cached = await SessionBlobCache.get(sessionId, String(fileId));
          if (cached && !cancelled) {
            const content = await cached.text();
            setText(content);
            setLoading(false);
            return;
          }
        }

        const content = await fetchFileAsText(apiClient, fileUrl);
        if (cancelled) return;

        // Cache as blob
        if (sessionId && fileId) {
          const blob = new Blob([content], { type: 'text/plain' });
          SessionBlobCache.put(sessionId, String(fileId), blob).catch(() => {});
        }

        setText(content);
        setLoading(false);
      } catch (err: any) {
        if (cancelled) return;
        setError(err.message || 'Failed to load');
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fileUrl, apiClient, sessionId, fileId]);

  return { text, loading, error };
}

// ─── Inline Previewers ─────────────────────────────────────────────

function PdfPreviewer({ file, sessionId }: { file: any; sessionId: string }) {
  const apiClient = useAPIClient();
  const { t } = useTranslation();
  const { blobUrl, loading, error } = useCachedBlobUrl(file, apiClient, sessionId);

  if (loading) return <LoadingIndicator msg={t('Loading preview...')} />;
  if (error || !blobUrl) return <ErrorMsg msg={t('Failed to load file preview')} />;
  return <iframe src={blobUrl} width="100%" height="100%" style={{ border: 'none' }} />;
}

function ImagePreviewer({ file, sessionId }: { file: any; sessionId: string }) {
  const apiClient = useAPIClient();
  const { t } = useTranslation();
  const { blobUrl, loading, error } = useCachedBlobUrl(file, apiClient, sessionId);

  if (loading) return <LoadingIndicator msg={t('Loading preview...')} />;
  if (error || !blobUrl) return <ErrorMsg msg={t('Failed to load file preview')} />;
  return <img src={blobUrl} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} alt={file?.filename || ''} />;
}

function TextPreviewer({ file, sessionId }: { file: any; sessionId: string }) {
  const apiClient = useAPIClient();
  const { t } = useTranslation();
  const { text, loading, error } = useCachedTextContent(file, apiClient, sessionId);

  if (loading) return <LoadingIndicator msg={t('Loading preview...')} />;
  if (error || text === null) return <ErrorMsg msg={t('Failed to load file preview')} />;
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

function DocxPreviewer({ file, sessionId }: { file: any; sessionId: string }) {
  const apiClient = useAPIClient();
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fileUrl = resolveFileUrl(file);
  const fileId = file?.id || file?.uid || '';

  useEffect(() => {
    let cancelled = false;
    if (!fileUrl || !containerRef.current) {
      setLoading(false);
      setError('No file URL');
      return;
    }

    setLoading(true);
    setError(null);

    (async () => {
      try {
        let blob: Blob;

        if (sessionId && fileId) {
          const cached = await SessionBlobCache.get(sessionId, String(fileId));
          if (cached && !cancelled) {
            blob = cached;
          } else {
            blob = await fetchFileAsBlob(apiClient, fileUrl);
            if (cancelled) return;
            SessionBlobCache.put(sessionId, String(fileId), blob).catch(() => {});
          }
        } else {
          blob = await fetchFileAsBlob(apiClient, fileUrl);
        }

        if (cancelled || !containerRef.current) return;
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
  }, [fileUrl, apiClient, sessionId, fileId]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {loading && <LoadingIndicator msg={t('Loading preview...')} />}
      {error && <ErrorMsg msg={t('Failed to load file preview')} />}
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

function XlsxPreviewer({ file, sessionId }: { file: any; sessionId: string }) {
  const apiClient = useAPIClient();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState('');
  const [sheetsHtml, setSheetsHtml] = useState<Record<string, string>>({});
  const fileUrl = resolveFileUrl(file);
  const fileId = file?.id || file?.uid || '';

  useEffect(() => {
    let cancelled = false;
    if (!fileUrl) {
      setLoading(false);
      setError('No file URL');
      return;
    }

    setLoading(true);
    setError(null);

    (async () => {
      try {
        let blob: Blob;

        if (sessionId && fileId) {
          const cached = await SessionBlobCache.get(sessionId, String(fileId));
          if (cached && !cancelled) {
            blob = cached;
          } else {
            blob = await fetchFileAsBlob(apiClient, fileUrl);
            if (cancelled) return;
            SessionBlobCache.put(sessionId, String(fileId), blob).catch(() => {});
          }
        } else {
          blob = await fetchFileAsBlob(apiClient, fileUrl);
        }

        if (cancelled) return;
        const XLSX = await import('xlsx');
        if (cancelled) return;
        const arrayBuffer = await blob.arrayBuffer();
        if (cancelled) return;
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });
        const names = workbook.SheetNames as string[];
        const htmlMap: Record<string, string> = {};
        for (const name of names) {
          htmlMap[name] = XLSX.utils.sheet_to_html(workbook.Sheets[name], { id: 'xlsx-preview-table' });
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
  }, [fileUrl, apiClient, sessionId, fileId]);

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {loading && <LoadingIndicator msg={t('Loading preview...')} />}
      {error && <ErrorMsg msg={t('Failed to load file preview')} />}
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
            style={{ flex: 1, overflow: 'auto', padding: 0 }}
            dangerouslySetInnerHTML={{ __html: sheetsHtml[activeSheet] || '' }}
          />
          <style>{`
            #xlsx-preview-table { border-collapse: collapse; width: 100%; font-size: 13px; }
            #xlsx-preview-table td, #xlsx-preview-table th {
              border: 1px solid #e8e8e8; padding: 6px 10px; text-align: left;
              max-width: 33vw; white-space: normal; word-break: break-word;
            }
            #xlsx-preview-table tr:first-child td, #xlsx-preview-table tr:first-child th {
              background: #fafafa; font-weight: 600; position: sticky; top: 0; z-index: 1;
            }
            #xlsx-preview-table tr:nth-child(even) { background: #fafafa; }
            #xlsx-preview-table tr:hover { background: #f0f7ff; }
          `}</style>
        </>
      )}
    </div>
  );
}

// ─── Main Preview Modal ────────────────────────────────────────────

export interface PreviewFile {
  id?: string | number;
  uid?: string;
  url?: string;
  filename?: string;
  name?: string;
  title?: string;
  extname?: string;
  mimetype?: string;
  size?: number;
}

interface PreviewModalProps {
  open: boolean;
  file: PreviewFile | null;
  sessionId: string;
  onClose: () => void;
}

export const PreviewModal: React.FC<PreviewModalProps> = ({ open, file, sessionId, onClose }) => {
  const apiClient = useAPIClient();
  const { t } = useTranslation();
  const [downloading, setDownloading] = useState(false);

  const fileId = file?.id || file?.uid || '';

  const onDownload = useCallback(async () => {
    if (!file) return;
    setDownloading(true);
    try {
      await downloadFileWithAuth(file, apiClient);
    } catch {
      message.error(t('Failed to download file'));
    } finally {
      setDownloading(false);
    }
  }, [file, apiClient, t]);

  const onClearCache = useCallback(async () => {
    if (!sessionId || !fileId) return;
    await SessionBlobCache.delete(sessionId, String(fileId));
    message.success(t('Cache cleared'));
  }, [sessionId, fileId, t]);

  const PreviewerComponent = useMemo(() => {
    if (!file) return null;
    if (isPdfFile(file)) return PdfPreviewer;
    if (isImageFile(file)) return ImagePreviewer;
    if (isTextFile(file)) return TextPreviewer;
    if (isDocxFile(file)) return DocxPreviewer;
    if (isXlsxFile(file)) return XlsxPreviewer;
    return null;
  }, [file]);

  const canPreview = PreviewerComponent != null;
  const title = file?.title && file?.extname ? `${file.title}${file.extname}` : file?.filename || file?.name || 'File';

  return (
    <Modal
      open={open}
      title={title}
      onCancel={onClose}
      destroyOnClose
      footer={[
        sessionId && fileId ? (
          <Button key="clear-cache" icon={<DeleteOutlined />} onClick={onClearCache}>
            {t('Clear cache')}
          </Button>
        ) : null,
        <Button key="download" icon={<DownloadOutlined />} onClick={onDownload} loading={downloading}>
          {t('Download')}
        </Button>,
        <Button key="close" onClick={onClose}>
          {t('Close')}
        </Button>,
      ].filter(Boolean)}
      width={canPreview ? '60vw' : 520}
      centered
    >
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
        {canPreview && file ? (
          <PreviewerComponent file={file} sessionId={sessionId} />
        ) : (
          <Alert
            type="info"
            style={{ width: '100%' }}
            description={t('This file type cannot be previewed. Click Download to save the file.')}
            showIcon
          />
        )}
      </div>
    </Modal>
  );
};
