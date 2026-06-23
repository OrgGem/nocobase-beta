import { DownloadOutlined } from '@ant-design/icons';
import type { Application } from '@nocobase/client-v2';
import { filePreviewTypes, type FilePreviewerProps } from '@nocobase/plugin-file-manager/client-v2';
import { Alert, Button, Modal, Space, Spin, message } from 'antd';
import React, { useCallback, useEffect, useRef, useState } from 'react';

type UnknownRecord = Record<string, unknown>;
type I18nLike = {
  t: (key: string, options?: Record<string, unknown>) => string;
};
type ApiClientLike = {
  auth?: {
    token?: string;
  };
};
type AppLike = Application & {
  apiClient?: ApiClientLike;
  i18n?: I18nLike;
};
type DownloadMode = 'inline' | 'attachment';

const NAMESPACE = 'plugin-file-preview-auth';
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'csv', 'json', 'xml', 'log', 'yaml', 'yml']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg']);
const WORD_EXTENSIONS = new Set(['docx', 'doc']);
const EXCEL_EXTENSIONS = new Set(['xlsx', 'xls', 'csv']);
const POWERPOINT_EXTENSIONS = new Set(['pptx', 'ppt']);

let appRef: AppLike | null = null;
let registered = false;
const blobCache = new Map<string, Promise<Blob>>();

const t = (key: string) => appRef?.i18n?.t(key, { ns: [NAMESPACE, 'client'], nsMode: 'fallback' }) || key;

const isBlobInstance = (value: unknown): value is Blob => typeof Blob !== 'undefined' && value instanceof Blob;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !isBlobInstance(value);

const getRecord = (value: unknown): UnknownRecord | null => (isRecord(value) ? value : null);

const getString = (record: UnknownRecord | null, key: string) => {
  const value = record?.[key];
  return typeof value === 'string' ? value : '';
};

const getNumberishString = (record: UnknownRecord | null, key: string) => {
  const value = record?.[key];
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  return '';
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

const getNestedPreviewRecord = (record: UnknownRecord) => {
  for (const key of ['file', 'record', 'attachment']) {
    const nested = getRecord(record[key]);
    if (nested && (nested.url || nested.preview || nested.path || nested.id || nested.uid)) {
      return nested;
    }
  }
  return record;
};

const normalizeFileInput = (file: unknown): unknown => {
  if (!isRecord(file)) {
    return file;
  }
  return getNestedPreviewRecord(file);
};

const getOriginBlob = (file: unknown): Blob | null => {
  if (isBlobInstance(file)) {
    return file;
  }
  const record = getRecord(normalizeFileInput(file));
  const originFileObj = record?.originFileObj;
  if (isBlobInstance(originFileObj)) {
    return originFileObj;
  }
  const blob = record?.blob;
  return isBlobInstance(blob) ? blob : null;
};

const resolveFileUrl = (file: unknown) => {
  if (typeof file === 'string') {
    return file;
  }
  const record = getRecord(normalizeFileInput(file));
  return (
    getString(record, 'preview') ||
    getString(record, 'url') ||
    getString(record, 'downloadUrl') ||
    getString(record, 'path')
  );
};

const getFileId = (file: unknown) => {
  const record = getRecord(normalizeFileInput(file));
  return (
    getNumberishString(record, 'id') || getNumberishString(record, 'uid') || getNumberishString(record, 'filterByTk')
  );
};

const getCollectionName = (file: unknown) => {
  const record = getRecord(normalizeFileInput(file));
  return (
    getString(record, 'collectionName') || getString(record, 'collection') || (getFileId(file) ? 'attachments' : '')
  );
};

const getMimeType = (file: unknown) => {
  const blob = getOriginBlob(file);
  if (blob?.type) {
    return blob.type.toLowerCase();
  }
  const record = getRecord(normalizeFileInput(file));
  return (getString(record, 'mimetype') || getString(record, 'type')).toLowerCase();
};

const getFileDisplayName = (file: unknown) => {
  const url = resolveFileUrl(file);
  if (typeof File !== 'undefined' && file instanceof File) {
    return file.name;
  }
  const record = getRecord(normalizeFileInput(file));
  return (
    getString(record, 'filename') ||
    getString(record, 'name') ||
    getString(record, 'title') ||
    getNameFromUrl(url) ||
    'file'
  );
};

const getFileExt = (file: unknown) => {
  const record = getRecord(normalizeFileInput(file));
  const extname = getString(record, 'extname');
  if (extname) {
    return extname.replace(/^\./, '').toLowerCase();
  }
  return (
    getExtFromName(getFileDisplayName(file)) ||
    getExtFromName(resolveFileUrl(file)) ||
    getExtFromName(getString(record, 'path'))
  );
};

const isPdfFile = (file: unknown) => getMimeType(file) === 'application/pdf' || getFileExt(file) === 'pdf';

const isImageFile = (file: unknown) => {
  const mimetype = getMimeType(file);
  return mimetype.startsWith('image/') || IMAGE_EXTENSIONS.has(getFileExt(file));
};

const isTextFile = (file: unknown) => {
  const mimetype = getMimeType(file);
  return mimetype.startsWith('text/') || TEXT_EXTENSIONS.has(getFileExt(file));
};

const isDocxFile = (file: unknown) => WORD_EXTENSIONS.has(getFileExt(file));

const isXlsxFile = (file: unknown) => EXCEL_EXTENSIONS.has(getFileExt(file));

const isPptxFile = (file: unknown) => POWERPOINT_EXTENSIONS.has(getFileExt(file));

const isPreviewableFile = (file: unknown) =>
  isPdfFile(file) || isImageFile(file) || isTextFile(file) || isDocxFile(file) || isXlsxFile(file) || isPptxFile(file);

const getDependencyKey = (file: unknown) => {
  const blob = getOriginBlob(file);
  if (blob) {
    const name = typeof File !== 'undefined' && blob instanceof File ? blob.name : '';
    return `blob:${name}:${blob.size}:${blob.type}`;
  }
  return [
    getFileId(file),
    resolveFileUrl(file),
    getFileDisplayName(file),
    getMimeType(file),
    getCollectionName(file),
  ].join('|');
};

const getStoragePayload = (record: UnknownRecord | null) => {
  const storage = getRecord(record?.storage);
  if (!storage) {
    return undefined;
  }
  return {
    id: storage.id,
    name: storage.name,
    type: storage.type,
  };
};

const buildFilePayload = (file: unknown) => {
  const record = getRecord(normalizeFileInput(file));
  if (!record) {
    return {};
  }
  return {
    id: record.id,
    uid: record.uid,
    url: record.url,
    preview: record.preview,
    path: record.path,
    storageId: record.storageId,
    collectionName: getCollectionName(file),
    filename: getFileDisplayName(file),
    mimetype: getMimeType(file),
    extname: getFileExt(file),
    storage: getStoragePayload(record),
  };
};

const buildAuthenticatedDownloadUrl = (file: unknown, mode: DownloadMode) => {
  const url = resolveFileUrl(file);
  if (url && /^(blob|data):/i.test(url)) {
    return url;
  }

  const id = getFileId(file);
  if (!url && !id) {
    throw new Error('url or id is required');
  }

  const params = new URLSearchParams();
  params.set('mode', mode);
  if (url) {
    params.set('url', url);
  }
  if (id) {
    params.set('id', id);
  }
  const collectionName = getCollectionName(file);
  if (collectionName) {
    params.set('collectionName', collectionName);
  }
  params.set('filename', getFileDisplayName(file));

  const mimetype = getMimeType(file);
  if (mimetype) {
    params.set('mimetype', mimetype);
  }

  const payload = buildFilePayload(file);
  if (Object.keys(payload).length > 0) {
    params.set('file', JSON.stringify(payload));
  }

  return `/api/filePreviewAuth:download?${params.toString()}`;
};

const getAuthHeaders = () => {
  const headers = new Headers();
  const token = appRef?.apiClient?.auth?.token;
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return headers;
};

const getLoadedFileBlob = async (file: unknown, mode: DownloadMode = 'inline') => {
  const directBlob = getOriginBlob(file);
  if (directBlob) {
    return directBlob;
  }

  const url = buildAuthenticatedDownloadUrl(file, mode);
  const token = appRef?.apiClient?.auth?.token || '';
  const cacheKey = `${mode}:${token}:${url}`;
  const cached = blobCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const request = fetch(url, {
    headers: /^(blob|data):/i.test(url) ? undefined : getAuthHeaders(),
    credentials: /^(blob|data):/i.test(url) ? undefined : 'include',
  }).then((response) => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.blob();
  });
  blobCache.set(cacheKey, request);
  return request;
};

const getDownloadFileName = (file: unknown) => {
  const filename = getFileDisplayName(file);
  const ext = getFileExt(file);
  if (filename && ext && !filename.toLowerCase().endsWith(`.${ext}`)) {
    return `${filename}.${ext}`;
  }
  return filename || 'file';
};

const downloadFileWithAuth = async (file: unknown) => {
  const blob = await getLoadedFileBlob(file, 'attachment');
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = getDownloadFileName(file);
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
};

const LoadingIndicator = () => (
  <div style={{ display: 'flex', height: '100%', width: '100%', alignItems: 'center', justifyContent: 'center' }}>
    <Spin tip={t('Loading preview...')} />
  </div>
);

const ErrorMessage = () => (
  <Alert type="error" style={{ width: '100%' }} message={t('Failed to load file preview')} showIcon />
);

const useBlobUrl = (file: unknown) => {
  const dependencyKey = getDependencyKey(file);
  const [state, setState] = useState<{ loading: boolean; error: boolean; url: string | null }>({
    loading: true,
    error: false,
    url: null,
  });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    setState({ loading: true, error: false, url: null });
    getLoadedFileBlob(file)
      .then((blob) => {
        if (cancelled) {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setState({ loading: false, error: false, url: objectUrl });
      })
      .catch(() => {
        if (!cancelled) {
          setState({ loading: false, error: true, url: null });
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [dependencyKey, file]);

  return state;
};

const useTextContent = (file: unknown) => {
  const dependencyKey = getDependencyKey(file);
  const [state, setState] = useState<{ loading: boolean; error: boolean; text: string }>({
    loading: true,
    error: false,
    text: '',
  });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: false, text: '' });
    getLoadedFileBlob(file)
      .then((blob) => blob.text())
      .then((text) => {
        if (!cancelled) {
          setState({ loading: false, error: false, text });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ loading: false, error: true, text: '' });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [dependencyKey, file]);

  return state;
};

function AuthPdfInlinePreviewer({ file }: FilePreviewerProps) {
  const { loading, error, url } = useBlobUrl(file);
  if (loading) return <LoadingIndicator />;
  if (error || !url) return <ErrorMessage />;
  return <iframe src={url} title={getFileDisplayName(file)} width="100%" height="100%" style={{ border: 'none' }} />;
}

function AuthImageInlinePreviewer({ file }: FilePreviewerProps) {
  const { loading, error, url } = useBlobUrl(file);
  if (loading) return <LoadingIndicator />;
  if (error || !url) return <ErrorMessage />;
  return (
    <img
      src={url}
      alt={getFileDisplayName(file)}
      style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
    />
  );
}

function AuthTextInlinePreviewer({ file }: FilePreviewerProps) {
  const { loading, error, text } = useTextContent(file);
  if (loading) return <LoadingIndicator />;
  if (error) return <ErrorMessage />;
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
        wordBreak: 'break-word',
        background: '#f5f5f5',
      }}
    >
      {text}
    </pre>
  );
}

function AuthDocxInlinePreviewer({ file }: FilePreviewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dependencyKey = getDependencyKey(file);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);

    getLoadedFileBlob(file)
      .then(async (blob) => {
        // @ts-ignore module is an optional runtime dependency of this plugin.
        const docxPreview = (await import('docx-preview')) as {
          renderAsync: (
            data: Blob,
            container: HTMLElement,
            styleContainer?: HTMLElement,
            options?: Record<string, unknown>,
          ) => Promise<void>;
        };
        if (cancelled || !containerRef.current) {
          return;
        }
        containerRef.current.innerHTML = '';
        await docxPreview.renderAsync(blob, containerRef.current, undefined, {
          className: 'docx-preview-wrapper',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          trimXmlDeclaration: true,
          useBase64URL: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
        });
        if (!cancelled) {
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
          setError(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [dependencyKey, file]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {loading && <LoadingIndicator />}
      {error && <ErrorMessage />}
      <div ref={containerRef} style={{ width: '100%', height: '100%', overflow: 'auto' }} />
    </div>
  );
}

function AuthXlsxInlinePreviewer({ file }: FilePreviewerProps) {
  const dependencyKey = getDependencyKey(file);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState('');
  const [sheetsHtml, setSheetsHtml] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);

    getLoadedFileBlob(file)
      .then(async (blob) => {
        // @ts-ignore module is an optional runtime dependency of this plugin.
        const XLSX = (await import('xlsx')) as {
          read: (
            data: ArrayBuffer,
            options: { type: 'array' },
          ) => {
            SheetNames: string[];
            Sheets: Record<string, unknown>;
          };
          utils: {
            sheet_to_html: (sheet: unknown, options: { id: string }) => string;
          };
        };
        const arrayBuffer = await blob.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });
        const htmlMap: Record<string, string> = {};
        for (const name of workbook.SheetNames) {
          htmlMap[name] = XLSX.utils.sheet_to_html(workbook.Sheets[name], { id: 'xlsx-preview-table' });
        }
        if (!cancelled) {
          setSheetNames(workbook.SheetNames);
          setActiveSheet(workbook.SheetNames[0] || '');
          setSheetsHtml(htmlMap);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
          setError(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [dependencyKey, file]);

  if (loading) return <LoadingIndicator />;
  if (error) return <ErrorMessage />;

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {sheetNames.length > 1 && (
        <div style={{ display: 'flex', overflowX: 'auto', borderBottom: '1px solid #e8e8e8', background: '#fafafa' }}>
          {sheetNames.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setActiveSheet(name)}
              style={{
                padding: '8px 16px',
                border: 'none',
                borderBottom: activeSheet === name ? '2px solid #1890ff' : '2px solid transparent',
                background: activeSheet === name ? '#fff' : 'transparent',
                color: activeSheet === name ? '#1890ff' : '#666',
                cursor: 'pointer',
                fontSize: 13,
                whiteSpace: 'nowrap',
              }}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto' }} dangerouslySetInnerHTML={{ __html: sheetsHtml[activeSheet] || '' }} />
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
      `}</style>
    </div>
  );
}

function AuthPptxInlinePreviewer({ file }: FilePreviewerProps) {
  const dependencyKey = getDependencyKey(file);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [fileBlob, setFileBlob] = useState<Blob | null>(null);
  const [PptxPreviewer, setPptxPreviewer] = useState<React.ComponentType<{ file: Blob | null }> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);

    Promise.all([
      getLoadedFileBlob(file),
      // @ts-ignore module is an optional runtime dependency of this plugin.
      import('react-pptx-preview-kit') as Promise<{ PptxPreview: React.ComponentType<{ file: Blob | null }> }>,
    ])
      .then(([blob, module]) => {
        if (!cancelled) {
          setFileBlob(blob);
          setPptxPreviewer(() => module.PptxPreview);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
          setError(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [dependencyKey, file]);

  if (loading) return <LoadingIndicator />;
  if (error || !PptxPreviewer) return <ErrorMessage />;
  return (
    <div style={{ width: '100%', height: '100%', overflow: 'auto' }}>
      <PptxPreviewer file={fileBlob} />
    </div>
  );
}

function AuthDownloadPreviewer({ file }: FilePreviewerProps) {
  const [downloading, setDownloading] = useState(false);
  const handleDownload = useCallback(async () => {
    setDownloading(true);
    try {
      await downloadFileWithAuth(file);
    } catch {
      message.error(t('Failed to download file'));
    } finally {
      setDownloading(false);
    }
  }, [file]);

  return (
    <Alert
      type="info"
      style={{ width: '100%' }}
      description={t('This file type cannot be previewed. Click Download to save the file.')}
      action={
        <Button type="primary" icon={<DownloadOutlined />} loading={downloading} onClick={handleDownload}>
          {t('Download')}
        </Button>
      }
      showIcon
    />
  );
}

const wrapWithAuthModalPreviewer = (Previewer: React.ComponentType<FilePreviewerProps>) => {
  return function AuthWrappedPreviewer(props: FilePreviewerProps) {
    const { open, onOpenChange, onClose, file } = props;
    const [downloading, setDownloading] = useState(false);
    const authOnDownload = useCallback(
      async (target?: unknown) => {
        setDownloading(true);
        try {
          await downloadFileWithAuth(target || file);
        } catch {
          message.error(t('Failed to download file'));
        } finally {
          setDownloading(false);
        }
      },
      [file],
    );
    const handleClose = useCallback(() => {
      onOpenChange?.(false);
      onClose?.();
    }, [onClose, onOpenChange]);

    if (typeof open !== 'boolean') {
      return <Previewer {...props} onDownload={authOnDownload} />;
    }

    return (
      <Modal
        open={open}
        title={getFileDisplayName(file)}
        onCancel={handleClose}
        footer={
          <Space>
            <Button icon={<DownloadOutlined />} loading={downloading} onClick={() => authOnDownload(file)}>
              {t('Download')}
            </Button>
            <Button onClick={handleClose}>{t('Close')}</Button>
          </Space>
        }
        width={isPreviewableFile(file) ? '90vw' : 560}
        centered
      >
        <div
          style={{
            maxWidth: '100%',
            maxHeight: isPreviewableFile(file) ? 'calc(100vh - 256px)' : 'auto',
            height: isPreviewableFile(file) ? '70vh' : 'auto',
            width: '100%',
            background: 'white',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            overflowY: 'auto',
          }}
        >
          <Previewer {...props} onDownload={authOnDownload} />
        </div>
      </Modal>
    );
  };
};

export function registerAuthenticatedFilePreviewTypes(app: Application) {
  appRef = app as AppLike;
  if (registered) {
    return;
  }
  registered = true;

  filePreviewTypes.add({
    match() {
      return true;
    },
    Previewer: wrapWithAuthModalPreviewer(AuthDownloadPreviewer),
  });

  filePreviewTypes.add({
    match: isPdfFile,
    Previewer: wrapWithAuthModalPreviewer(AuthPdfInlinePreviewer),
  });

  filePreviewTypes.add({
    match: isImageFile,
    getThumbnailURL(file: unknown) {
      const url = resolveFileUrl(file);
      return url && !/\/api\/(attachments:stream|filePreviewAuth:download)/.test(url) ? url : null;
    },
    Previewer: wrapWithAuthModalPreviewer(AuthImageInlinePreviewer),
  });

  filePreviewTypes.add({
    match: isTextFile,
    Previewer: wrapWithAuthModalPreviewer(AuthTextInlinePreviewer),
  });

  filePreviewTypes.add({
    match: isDocxFile,
    Previewer: wrapWithAuthModalPreviewer(AuthDocxInlinePreviewer),
  });

  filePreviewTypes.add({
    match: isXlsxFile,
    Previewer: wrapWithAuthModalPreviewer(AuthXlsxInlinePreviewer),
  });

  filePreviewTypes.add({
    match: isPptxFile,
    Previewer: wrapWithAuthModalPreviewer(AuthPptxInlinePreviewer),
  });
}
