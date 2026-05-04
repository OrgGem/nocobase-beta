/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DownloadOutlined, LeftOutlined, RightOutlined, CopyOutlined } from '@ant-design/icons';
import { Modal, Button, Spin, Alert, Space, message } from 'antd';
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

// ─── Utility functions ──────────────────────────────────────────────

const getFileExt = (file: any): string => {
  const value = typeof file === 'string' ? file : file?.extname || file?.name || file?.filename || file?.url || '';
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
  const url = typeof file === 'string' ? file : file?.url;
  if (!url) {
    return '';
  }
  return url.startsWith('https://') || url.startsWith('http://') ? url : `${location.origin}/${url.replace(/^\//, '')}`;
};

const isPdfFile = (file: any): boolean => {
  if (file?.mimetype && PDF_MIME_TYPES.includes(file.mimetype)) return true;
  const ext = getFileExt(file);
  return !!ext && PDF_EXTS.includes(ext);
};

const isImageFile = (file: any): boolean => {
  if (file?.mimetype && IMAGE_MIME_TYPES.includes(file.mimetype)) return true;
  if (file?.mimetype && matchMimetype(file, 'image/*')) return true;
  const ext = getFileExt(file);
  return !!ext && IMAGE_EXTS.includes(ext);
};

const isTextFile = (file: any): boolean => {
  if (file?.mimetype && TEXT_MIME_TYPES.includes(file.mimetype)) return true;
  const ext = getFileExt(file);
  return !!ext && TEXT_EXTS.includes(ext);
};

const isDocxFile = (file: any): boolean => {
  if (file?.mimetype && DOCX_MIME_TYPES.includes(file.mimetype)) return true;
  const ext = getFileExt(file);
  return !!ext && DOCX_EXTS.includes(ext);
};

const isXlsxFile = (file: any): boolean => {
  if (file?.mimetype && XLSX_MIME_TYPES.includes(file.mimetype)) return true;
  const ext = getFileExt(file);
  return !!ext && XLSX_EXTS.includes(ext);
};

const isPptxFile = (file: any): boolean => {
  if (file?.mimetype && PPTX_MIME_TYPES.includes(file.mimetype)) return true;
  const ext = getFileExt(file);
  return !!ext && PPTX_EXTS.includes(ext);
};

const isPreviewableFile = (file: any): boolean => {
  return isPdfFile(file) || isImageFile(file) || isTextFile(file) || isDocxFile(file) || isXlsxFile(file) || isPptxFile(file);
};

const getFileDisplayName = (file: any): string => {
  if (!file) return 'download';
  if (file.title && file.extname) return `${file.title}${file.extname}`;
  return file.filename || file.name || file.title || 'download';
};

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

async function fetchFileAsText(url: string, token: string): Promise<string> {
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
  return response.text();
}

// ─── Authenticated download helper ─────────────────────────────────

async function downloadFileWithAuth(file: any, token: string): Promise<void> {
  const url = resolveFileUrl(file);
  if (!url) return;
  const blob = await fetchFileAsBlob(url, token);
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

  useEffect(() => {
    let cancelled = false;
    const url = resolveFileUrl(file);
    if (!url) {
      setLoading(false);
      setError('No file URL');
      return;
    }

    setLoading(true);
    setError(null);

    fetchFileAsBlob(url, token)
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
  }, [typeof file === 'string' ? file : file?.url, token]);

  return { blobUrl, loading, error };
}

// ─── useTextContent hook ────────────────────────────────────────────

function useTextContent(file: any, token: string) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const url = resolveFileUrl(file);
    if (!url) {
      setLoading(false);
      setError('No file URL');
      return;
    }

    setLoading(true);
    setError(null);

    fetchFileAsText(url, token)
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
  }, [typeof file === 'string' ? file : file?.url, token]);

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

function PreviewModalTitle({ file, title }: { file: any; title: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingRight: 40 }}>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={title}>
        {title}
      </span>
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const url = resolveFileUrl(file);
    if (!url || !containerRef.current) {
      setLoading(false);
      setError('No file URL');
      return;
    }

    setLoading(true);
    setError(null);

    (async () => {
      try {
        const blob = await fetchFileAsBlob(url, token);
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
  }, [typeof file === 'string' ? file : file?.url, token]);

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState<string>('');
  const [sheetsHtml, setSheetsHtml] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const url = resolveFileUrl(file);
    if (!url) {
      setLoading(false);
      setError('No file URL');
      return;
    }

    setLoading(true);
    setError(null);

    (async () => {
      try {
        const blob = await fetchFileAsBlob(url, token);
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
  }, [typeof file === 'string' ? file : file?.url, token]);

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
  const [arrayBuffer, setArrayBuffer] = useState<ArrayBuffer | null>(null);
  const [PptxPreviewer, setPptxPreviewer] = useState<any>(null);

  useEffect(() => {
    let cancelled = false;
    const url = resolveFileUrl(file);
    if (!url) {
      setLoading(false);
      setError('No file URL');
      return;
    }

    setLoading(true);
    setError(null);

    (async () => {
      try {
        const [blob, module] = await Promise.all([
          fetchFileAsBlob(url, token),
          // @ts-ignore
          import('react-pptx-preview-kit')
        ]);
        if (cancelled) return;
        const buffer = await blob.arrayBuffer();
        if (cancelled) return;
        setArrayBuffer(buffer);
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
  }, [typeof file === 'string' ? file : file?.url, token]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {loading && <LoadingIndicator message={t('Loading preview...')} />}
      {error && <ErrorMessage message={t('Failed to load file preview')} />}
      {!loading && !error && PptxPreviewer && (
        <div style={{ width: '100%', height: '100%', overflow: 'auto' }}>
           <PptxPreviewer file={arrayBuffer} />
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
    const [previewMode, setPreviewMode] = useState<'visual' | 'raw'>('visual');

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
              <Button onClick={() => setPreviewMode(prev => prev === 'visual' ? 'raw' : 'visual')}>
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
        const response = await apiClient.request({
          url: 'filePreviewAuth:getContent',
          params: { file },
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
      navigator.clipboard.writeText(content).then(() => {
        message.success(t('Copied to clipboard'));
      }).catch((err) => {
        message.error(t('Failed to copy'));
        console.error('Copy error', err);
      });
    } else {
      // Fallback
      const textArea = document.createElement("textarea");
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
          fontSize: '13px'
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

  return (
    <Modal
      open={index != null}
      title={<PreviewModalTitle file={file} title={file?.title || file?.filename || file?.name || 'File'} />}
      onCancel={onClose}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
          <div key="left-actions">
            <Button onClick={() => setPreviewMode(prev => prev === 'visual' ? 'raw' : 'visual')}>
              {previewMode === 'visual' ? t('View Raw Parsed Text') : t('View Visual Preview')}
            </Button>
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
        return file?.url || file?.preview || null;
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
}

export default PluginFilePreviewAuthClient;
