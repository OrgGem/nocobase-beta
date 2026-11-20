// SPDX-License-Identifier: Apache-2.0

import { DownloadOutlined } from '@ant-design/icons';
import { Alert, Button, Modal, Space, Spin } from 'antd';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createDocumentPreviewPdfUrl,
  DocumentPreviewError,
  fetchDocumentBlob,
  getCurrentAuthToken,
  getDocumentInitialTitle,
  getDocumentSourceKey,
  getExtensionFromFilename,
  hasPdfMagicHeader,
  hasZipMagicHeader,
  readBlobBytes,
  triggerBlobDownload,
  type DocumentPreviewAppLike,
  type DocumentPreviewErrorCode,
  type DocumentPreviewHandle,
  type DocumentPreviewSource,
  type LoadedDocument,
} from './documentPreview';
import { parseXlsxSheetsToRows } from './previewHelpers';

const NAMESPACE = 'plugin-file-preview-auth';
const AUTH_WATCH_INTERVAL_MS = 500;

interface DocumentPreviewModalState {
  open: boolean;
  requestId: number;
  sourceKey: string;
  sessionToken: string;
  title: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  document: LoadedDocument | null;
  errorCode: DocumentPreviewErrorCode | null;
  errorMessage: string | null;
}

const INITIAL_STATE: DocumentPreviewModalState = {
  open: false,
  requestId: 0,
  sourceKey: '',
  sessionToken: '',
  title: '',
  status: 'idle',
  document: null,
  errorCode: null,
  errorMessage: null,
};

type TranslateFn = (key: string) => string;

function createTranslator(app: DocumentPreviewAppLike): TranslateFn {
  return (key: string) => app.i18n?.t(key, { ns: [NAMESPACE, 'client'], nsMode: 'fallback' }) || key;
}

function getLocalizedErrorMessage(
  code: DocumentPreviewErrorCode | null,
  fallback: string | null,
  t: TranslateFn,
): string {
  switch (code) {
    case 'AUTH_REQUIRED':
      return t('Please sign in to preview this file.');
    case 'FORBIDDEN':
      return t('You do not have permission to access this file.');
    case 'NOT_FOUND':
      return t('File not found.');
    case 'UNEXPECTED_HTML':
      return t('Received an unexpected HTML response instead of the requested document.');
    case 'INVALID_SOURCE':
      return t('Invalid document preview source.');
    default:
      return fallback || t('Failed to load file preview');
  }
}

class ViewerErrorBoundary extends React.Component<
  { fallback: React.ReactNode; resetKey: string; children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: React.ReactNode; resetKey: string; children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: { resetKey: string }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

function ParseFailureNotice({ t, onDownload }: { t: TranslateFn; onDownload: () => void }) {
  return (
    <div style={{ padding: 24, width: '100%' }}>
      <Alert
        type="warning"
        showIcon
        message={t('Unable to render document preview')}
        description={t(
          'The file was loaded, but its preview could not be rendered. You can still download the original file.',
        )}
        action={
          <Button type="primary" icon={<DownloadOutlined />} onClick={onDownload}>
            {t('Download')}
          </Button>
        }
      />
    </div>
  );
}

function LocalPdfViewer({ doc, t, onDownload }: { doc: LoadedDocument; t: TranslateFn; onDownload: () => void }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const isValidPdf = hasPdfMagicHeader(doc.headerBytes);

  useEffect(() => {
    if (!isValidPdf) {
      setBlobUrl(null);
      return;
    }
    const objectUrl = createDocumentPreviewPdfUrl(doc.blob);
    setBlobUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [doc.blob, isValidPdf]);

  if (!isValidPdf) {
    return <ParseFailureNotice t={t} onDownload={onDownload} />;
  }

  if (!blobUrl) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', width: '100%' }}>
        <Spin />
      </div>
    );
  }

  return <iframe src={blobUrl} title={doc.filename} width="100%" height="100%" style={{ border: 'none' }} />;
}

function LocalTextViewer({ doc, t, onDownload }: { doc: LoadedDocument; t: TranslateFn; onDownload: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setFailed(false);

    const decode = async () => {
      try {
        const bytes = await readBlobBytes(doc.blob);
        if (cancelled) return;
        let decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        const ext = getExtensionFromFilename(doc.filename);
        if (ext === 'json' || doc.mimeType === 'application/json' || doc.mimeType === 'text/json') {
          try {
            decoded = JSON.stringify(JSON.parse(decoded), null, 2);
          } catch {
            // Keep raw text when JSON is malformed so the user can inspect it.
          }
        }
        setText(decoded);
      } catch {
        if (!cancelled) {
          setFailed(true);
        }
      }
    };

    decode();
    return () => {
      cancelled = true;
    };
  }, [doc.blob, doc.filename, doc.mimeType]);

  if (failed) {
    return <ParseFailureNotice t={t} onDownload={onDownload} />;
  }

  if (text === null) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', width: '100%' }}>
        <Spin />
      </div>
    );
  }

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

function LocalDocxViewer({ doc, t, onDownload }: { doc: LoadedDocument; t: TranslateFn; onDownload: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);

    const renderDocx = async () => {
      try {
        if (!hasZipMagicHeader(doc.headerBytes)) {
          throw new Error('Invalid DOCX container');
        }
        // @ts-ignore runtime dependency of this plugin
        const docxPreview = (await import('docx-preview')) as {
          renderAsync: (
            data: Blob | ArrayBuffer,
            container: HTMLElement,
            styleContainer?: HTMLElement,
            options?: Record<string, unknown>,
          ) => Promise<void>;
        };
        const bytes = await readBlobBytes(doc.blob);
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = '';
        await docxPreview.renderAsync(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          containerRef.current,
          undefined,
          {
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
          },
        );
        if (!cancelled) {
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setLoading(false);
          setFailed(true);
        }
      }
    };

    renderDocx();
    return () => {
      cancelled = true;
    };
  }, [doc.blob, doc.headerBytes]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', width: '100%' }}>
          <Spin />
        </div>
      )}
      {failed && <ParseFailureNotice t={t} onDownload={onDownload} />}
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          overflow: 'auto',
          display: loading || failed ? 'none' : 'block',
        }}
      />
    </div>
  );
}

function LocalSpreadsheetViewer({
  doc,
  t,
  onDownload,
}: {
  doc: LoadedDocument;
  t: TranslateFn;
  onDownload: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState('');
  const [sheetsRows, setSheetsRows] = useState<Record<string, string[][]>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);

    const parseWorkbook = async () => {
      try {
        const ext = getExtensionFromFilename(doc.filename);
        if (ext === 'xlsx' && !hasZipMagicHeader(doc.headerBytes)) {
          throw new Error('Invalid XLSX container');
        }
        // @ts-ignore runtime dependency of this plugin
        const XLSX = (await import('xlsx')) as {
          read: (
            data: ArrayBuffer,
            options: { type: 'array' },
          ) => {
            SheetNames: string[];
            Sheets: Record<string, unknown>;
          };
          utils: {
            sheet_to_json: <T = unknown>(sheet: unknown, options: { header: number; defval: string }) => T[];
          };
        };
        const bytes = await readBlobBytes(doc.blob);
        const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });
        const parsed = parseXlsxSheetsToRows(workbook, XLSX.utils);
        if (parsed.sheetNames.length === 0) {
          throw new Error('Workbook contains no sheets');
        }
        if (!cancelled) {
          setSheetNames(parsed.sheetNames);
          setActiveSheet(parsed.sheetNames[0] || '');
          setSheetsRows(parsed.sheetsRows);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setLoading(false);
          setFailed(true);
        }
      }
    };

    parseWorkbook();
    return () => {
      cancelled = true;
    };
  }, [doc.blob, doc.filename, doc.headerBytes]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', width: '100%' }}>
        <Spin />
      </div>
    );
  }

  if (failed) {
    return <ParseFailureNotice t={t} onDownload={onDownload} />;
  }

  const activeRows = sheetsRows[activeSheet] || [];
  const columnCount = activeRows.reduce((max, row) => Math.max(max, row.length), 0);
  const headerRow = activeRows[0] || [];
  const bodyRows = activeRows.slice(1);

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {sheetNames.length > 1 && (
        <div
          role="tablist"
          aria-label={t('Sheets')}
          style={{ display: 'flex', overflowX: 'auto', borderBottom: '1px solid #e8e8e8', background: '#fafafa' }}
        >
          {sheetNames.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={activeSheet === name}
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
      <div style={{ flex: 1, overflow: 'auto' }}>
        {activeRows.length > 0 && columnCount > 0 ? (
          <table className="document-preview-xlsx-table">
            <thead>
              <tr>
                {Array.from({ length: columnCount }, (_, colIdx) => (
                  <th key={colIdx}>{headerRow[colIdx] ?? ''}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, rowIdx) => (
                <tr key={rowIdx}>
                  {Array.from({ length: columnCount }, (_, colIdx) => (
                    <td key={colIdx}>{row[colIdx] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
      <style>{`
        .document-preview-xlsx-table {
          border-collapse: collapse;
          width: 100%;
          font-size: 13px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        .document-preview-xlsx-table td,
        .document-preview-xlsx-table th {
          border: 1px solid #e8e8e8;
          padding: 6px 10px;
          text-align: left;
          max-width: 33vw;
          white-space: normal;
          word-break: break-word;
        }
        .document-preview-xlsx-table thead th {
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

function LocalPptxViewer({ doc, t, onDownload }: { doc: LoadedDocument; t: TranslateFn; onDownload: () => void }) {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [PptxPreviewer, setPptxPreviewer] = useState<React.ComponentType<{ file: Blob | null }> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);

    const loadViewer = async () => {
      try {
        if (!hasZipMagicHeader(doc.headerBytes)) {
          throw new Error('Invalid PPTX container');
        }
        // @ts-ignore runtime dependency of this plugin
        const mod = (await import('react-pptx-preview-kit')) as {
          PptxPreview?: React.ComponentType<{ file: Blob | null }>;
        };
        if (!mod?.PptxPreview) {
          throw new Error('PPTX previewer unavailable');
        }
        if (!cancelled) {
          setPptxPreviewer(() => mod.PptxPreview || null);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setLoading(false);
          setFailed(true);
        }
      }
    };

    loadViewer();
    return () => {
      cancelled = true;
    };
  }, [doc.blob, doc.headerBytes]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', width: '100%' }}>
        <Spin />
      </div>
    );
  }

  if (failed || !PptxPreviewer) {
    return <ParseFailureNotice t={t} onDownload={onDownload} />;
  }

  return (
    <ViewerErrorBoundary
      resetKey={`${doc.filename}:${doc.blob.size}`}
      fallback={<ParseFailureNotice t={t} onDownload={onDownload} />}
    >
      <div style={{ width: '100%', height: '100%', overflow: 'auto' }}>
        <PptxPreviewer file={doc.blob} />
      </div>
    </ViewerErrorBoundary>
  );
}

function DocumentPreviewModalView({
  state,
  t,
  onClose,
  onDownload,
}: {
  state: DocumentPreviewModalState;
  t: TranslateFn;
  onClose: () => void;
  onDownload: () => void;
}) {
  const doc = state.document;
  const canPreviewBody =
    state.status === 'loading' || (state.status === 'ready' && doc !== null && doc.viewerKind !== 'unsupported');

  const renderBody = () => {
    if (state.status === 'loading') {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            gap: 12,
            height: '100%',
            width: '100%',
          }}
        >
          <Spin size="large" />
          <span style={{ color: '#666' }}>{t('Loading preview...')}</span>
        </div>
      );
    }

    if (state.status === 'error') {
      return (
        <div style={{ padding: 24, width: '100%' }}>
          <Alert
            type="error"
            showIcon
            message={t('Failed to load file preview')}
            description={getLocalizedErrorMessage(state.errorCode, state.errorMessage, t)}
          />
        </div>
      );
    }

    if (state.status !== 'ready' || !doc) {
      return null;
    }

    switch (doc.viewerKind) {
      case 'pdf':
        return <LocalPdfViewer doc={doc} t={t} onDownload={onDownload} />;
      case 'text':
        return <LocalTextViewer doc={doc} t={t} onDownload={onDownload} />;
      case 'docx':
        return <LocalDocxViewer doc={doc} t={t} onDownload={onDownload} />;
      case 'xlsx':
        return <LocalSpreadsheetViewer doc={doc} t={t} onDownload={onDownload} />;
      case 'pptx':
        return <LocalPptxViewer doc={doc} t={t} onDownload={onDownload} />;
      case 'unsupported':
      default:
        return (
          <div style={{ padding: 24, width: '100%' }}>
            <Alert
              type="info"
              showIcon
              description={t('This file type cannot be previewed. Click Download to save the file.')}
              action={
                <Button type="primary" icon={<DownloadOutlined />} onClick={onDownload}>
                  {t('Download')}
                </Button>
              }
            />
          </div>
        );
    }
  };

  return (
    <Modal
      open={state.open}
      title={state.title || t('Preview')}
      onCancel={onClose}
      destroyOnClose
      footer={
        <Space>
          <Button icon={<DownloadOutlined />} disabled={!doc} onClick={onDownload}>
            {t('Download')}
          </Button>
          <Button onClick={onClose}>{t('Close')}</Button>
        </Space>
      }
      width={canPreviewBody ? '90vw' : 560}
      centered
    >
      <div
        style={{
          width: '100%',
          height: canPreviewBody ? '70vh' : 'auto',
          maxHeight: canPreviewBody ? 'calc(100vh - 256px)' : 'auto',
          background: '#fff',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          overflow: 'hidden',
        }}
      >
        {renderBody()}
      </div>
    </Modal>
  );
}

export class DocumentPreviewController {
  private readonly app: DocumentPreviewAppLike;
  private readonly t: TranslateFn;
  private state: DocumentPreviewModalState = { ...INITIAL_STATE };
  private abortController: AbortController | null = null;
  private requestSeq = 0;
  private container: HTMLDivElement | null = null;
  private root: Root | null = null;
  private authWatchTimer: ReturnType<typeof setInterval> | null = null;
  private storageListener: (() => void) | null = null;

  constructor(app: DocumentPreviewAppLike) {
    this.app = app;
    this.t = createTranslator(app);
  }

  openDocumentPreview = (source: DocumentPreviewSource): DocumentPreviewHandle => {
    const sourceKey = getDocumentSourceKey(source);
    const currentToken = getCurrentAuthToken(this.app.apiClient);

    // Deduplicate double-clicks for the same document within the same authenticated session.
    if (
      this.state.open &&
      this.state.sourceKey === sourceKey &&
      this.state.sessionToken === currentToken &&
      currentToken !== '' &&
      (this.state.status === 'loading' || this.state.status === 'ready')
    ) {
      return { close: this.close };
    }

    this.abortInFlight();
    const requestId = ++this.requestSeq;
    const title = getDocumentInitialTitle(source);

    if (!currentToken) {
      this.stopAuthWatcher();
      this.setState({
        open: true,
        requestId,
        sourceKey,
        sessionToken: '',
        title,
        status: 'error',
        document: null,
        errorCode: 'AUTH_REQUIRED',
        errorMessage: null,
      });
      return { close: this.close };
    }

    const controller = new AbortController();
    this.abortController = controller;
    this.setState({
      open: true,
      requestId,
      sourceKey,
      sessionToken: currentToken,
      title,
      status: 'loading',
      document: null,
      errorCode: null,
      errorMessage: null,
    });
    this.startAuthWatcher();
    this.loadDocument(requestId, source, sourceKey, currentToken, controller);

    return { close: this.close };
  };

  close = (): void => {
    this.abortInFlight();
    this.stopAuthWatcher();
    this.requestSeq += 1;
    this.setState({
      ...INITIAL_STATE,
      requestId: this.requestSeq,
    });
  };

  destroy = (): void => {
    this.close();
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  };

  private async loadDocument(
    requestId: number,
    source: DocumentPreviewSource,
    sourceKey: string,
    sessionToken: string,
    controller: AbortController,
  ): Promise<void> {
    try {
      const loaded = await fetchDocumentBlob(this.app.apiClient, source, controller.signal);
      if (this.isStaleRequest(requestId, sessionToken, controller)) {
        return;
      }
      this.abortController = null;
      this.setState({
        open: true,
        requestId,
        sourceKey,
        sessionToken,
        title: loaded.filename,
        status: 'ready',
        document: loaded,
        errorCode: null,
        errorMessage: null,
      });
    } catch (err: unknown) {
      if (this.isStaleRequest(requestId, sessionToken, controller)) {
        return;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      this.abortController = null;
      const previewError = err instanceof DocumentPreviewError ? err : null;
      this.setState({
        open: true,
        requestId,
        sourceKey,
        sessionToken,
        title: this.state.title,
        status: 'error',
        document: null,
        errorCode: previewError?.code || 'FETCH_FAILED',
        errorMessage: previewError?.message || (err instanceof Error ? err.message : null),
      });
    }
  }

  private handleDownload = (): void => {
    const doc = this.state.document;
    if (!doc) {
      return;
    }
    const currentToken = getCurrentAuthToken(this.app.apiClient);
    if (!currentToken || currentToken !== this.state.sessionToken) {
      this.close();
      return;
    }
    triggerBlobDownload(doc.blob, doc.filename);
  };

  private isStaleRequest(requestId: number, sessionToken: string, controller: AbortController): boolean {
    if (requestId !== this.requestSeq || controller.signal.aborted) {
      return true;
    }
    const currentToken = getCurrentAuthToken(this.app.apiClient);
    return !currentToken || currentToken !== sessionToken;
  }

  private abortInFlight(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private startAuthWatcher(): void {
    this.stopAuthWatcher();
    if (typeof window === 'undefined') {
      return;
    }
    const verifySession = () => {
      if (!this.state.open || !this.state.sessionToken) {
        return;
      }
      const currentToken = getCurrentAuthToken(this.app.apiClient);
      if (!currentToken || currentToken !== this.state.sessionToken) {
        this.close();
      }
    };
    this.storageListener = verifySession;
    window.addEventListener('storage', verifySession);
    this.authWatchTimer = setInterval(verifySession, AUTH_WATCH_INTERVAL_MS);
  }

  private stopAuthWatcher(): void {
    if (this.authWatchTimer !== null) {
      clearInterval(this.authWatchTimer);
      this.authWatchTimer = null;
    }
    if (this.storageListener && typeof window !== 'undefined') {
      window.removeEventListener('storage', this.storageListener);
      this.storageListener = null;
    }
  }

  private ensureRoot(): Root | null {
    if (typeof document === 'undefined') {
      return null;
    }
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.dataset.filePreviewAuthDocumentModal = 'true';
      document.body.appendChild(this.container);
    }
    if (!this.root) {
      this.root = createRoot(this.container);
    }
    return this.root;
  }

  private setState(next: DocumentPreviewModalState): void {
    this.state = next;
    this.render();
  }

  private render(): void {
    const root = this.ensureRoot();
    if (!root) {
      return;
    }
    root.render(
      <DocumentPreviewModalView state={this.state} t={this.t} onClose={this.close} onDownload={this.handleDownload} />,
    );
  }
}
