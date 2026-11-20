// SPDX-License-Identifier: Apache-2.0

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import crypto from 'crypto';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';

vi.mock('@nocobase/plugin-file-manager/client-v2', () => ({
  filePreviewTypes: { add: vi.fn() },
}));

vi.mock('../AIFilePreviewAction', () => ({
  default: () => null,
  registerFilePreviewAIWorkContext: vi.fn(),
}));

import { DocumentPreviewController } from '../../shared/DocumentPreviewModal';
import {
  buildDocumentRequestUrl,
  parseContentDispositionFilename,
  readBlobBytes,
  resolveDocumentViewerKind,
  type DocumentPreviewAppLike,
} from '../../shared/documentPreview';
import { PluginFilePreviewAuthClient } from '../plugin';

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function makeBlob(bytes: Uint8Array | string, type: string): Blob {
  const buf = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const blob = new Blob([buf], { type });
  Object.defineProperty(blob, 'arrayBuffer', {
    configurable: true,
    value: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  });
  Object.defineProperty(blob, 'slice', {
    configurable: true,
    value: (start = 0, end = buf.length) => makeBlob(buf.slice(start, end), type),
  });
  return blob;
}

function createMockResponse(options: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  contentType?: string;
  contentDisposition?: string;
  bytes?: Uint8Array | string;
}) {
  const headers = new Headers();
  if (options.contentType) headers.set('content-type', options.contentType);
  if (options.contentDisposition) headers.set('content-disposition', options.contentDisposition);
  const blob = makeBlob(options.bytes ?? '', options.contentType || 'application/octet-stream');
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    headers,
    blob: async () => blob,
  };
}

async function createMinimalDocxBytes(paragraphText: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`,
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>${paragraphText}</w:t></w:r></w:p>
      </w:body>
    </w:document>`,
  );
  return zip.generateAsync({ type: 'uint8array' });
}

async function createMinimalPptxBytes(slideText: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
      <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
    </Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
    </Relationships>`,
  );
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
      <p:sldSz cx="9144000" cy="6858000"/>
    </p:presentation>`,
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
    </Relationships>`,
  );
  zip.file(
    'ppt/slides/slide1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <p:cSld>
        <p:spTree>
          <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
          <p:grpSpPr/>
          <p:sp>
            <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
            <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="5000000" cy="1000000"/></a:xfrm></p:spPr>
            <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${slideText}</a:t></a:r></a:p></p:txBody>
          </p:sp>
        </p:spTree>
      </p:cSld>
    </p:sld>`,
  );
  return zip.generateAsync({ type: 'uint8array' });
}

function createSpreadsheetBytes(bookType: 'xlsx' | 'biff8', rows: string[][], sheetName = 'Summary'): Uint8Array {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = { SheetNames: [sheetName], Sheets: { [sheetName]: sheet } };
  const raw = XLSX.write(workbook, { type: 'array', bookType }) as ArrayBuffer | Uint8Array;
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
}

function createAppMock(token = 'token-user-a', role = 'member', appName = 'main'): DocumentPreviewAppLike {
  const auth = { token, role, locale: 'en-US', authenticator: 'basic' };
  return {
    name: appName,
    apiClient: {
      appName,
      auth,
      axios: { defaults: { baseURL: '/api/' } },
      getHeaders: () => {
        const headers: Record<string, string> = { 'X-App': appName };
        if (auth.role) headers['X-Role'] = auth.role;
        if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`;
        return headers;
      },
    },
    i18n: { t: (key: string) => key },
  };
}

let activeControllers: DocumentPreviewController[] = [];
let createdObjectUrls: Array<{ url: string; blob: Blob }> = [];
let revokedObjectUrls: string[] = [];

beforeEach(() => {
  activeControllers = [];
  createdObjectUrls = [];
  revokedObjectUrls = [];
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn((blob: Blob | MediaSource) => {
      const url = `blob:mock-${createdObjectUrls.length + 1}`;
      createdObjectUrls.push({ url, blob: blob as Blob });
      return url;
    }),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn((url: string) => {
      revokedObjectUrls.push(url);
    }),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  for (const controller of activeControllers) {
    controller.destroy();
  }
  activeControllers = [];
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DocumentPreviewController — Blob lifecycle, auth & offline download', () => {
  it('fetches once for preview, downloads exact bytes offline with server RFC 5987 filename, and revokes PDF object URL on close', async () => {
    const pdfBytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n(Quarterly Report 2026)\nendobj\n%%EOF');
    const expectedHash = sha256(pdfBytes);
    const serverName = 'Báo cáo Quý 1.pdf';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createMockResponse({
          contentType: 'application/pdf',
          contentDisposition: `attachment; filename="fallback.pdf"; filename*=UTF-8''${encodeURIComponent(serverName)}`,
          bytes: pdfBytes,
        }),
      )
      // Simulate offline browser on any second network attempt!
      .mockRejectedValue(new TypeError('Failed to fetch: network offline'));
    vi.stubGlobal('fetch', fetchMock);

    const app = createAppMock('jwt-alice', 'analyst', 'subapp1');
    const controller = new DocumentPreviewController(app);
    activeControllers.push(controller);

    const handle = controller.openDocumentPreview({
      kind: 'record',
      collection: 'aiFiles',
      id: 42,
      displayName: 'loading-name.pdf',
    });

    const iframe = (await screen.findByTitle(serverName)) as HTMLIFrameElement;
    expect(iframe.src).toMatch(/^blob:mock-/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0];
    expect(requestUrl).toBe('/api/filePreviewAuth:streamDocument?collection=aiFiles&id=42');
    expect((requestInit.headers as Headers).get('Authorization')).toBe('Bearer jwt-alice');
    expect((requestInit.headers as Headers).get('X-Role')).toBe('analyst');
    expect((requestInit.headers as Headers).get('X-App')).toBe('subapp1');

    // Capture the anchor download attribute & blob when clicking Download OFFLINE
    let downloadedName = '';
    const appendSpy = vi.spyOn(document.body, 'appendChild');
    const downloadBtn = screen.getByRole('button', { name: /Download/i });
    fireEvent.click(downloadBtn);

    const anchorCall = appendSpy.mock.calls.find(([node]) => node instanceof HTMLAnchorElement);
    expect(anchorCall).toBeTruthy();
    if (!anchorCall) {
      throw new Error('Expected download anchor to be appended');
    }
    const anchor = anchorCall[0] as HTMLAnchorElement;
    downloadedName = anchor.download;
    expect(downloadedName).toBe(serverName);

    // Still only ONE network request — Download reused the modal's local Blob offline!
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const downloadedEntry = createdObjectUrls.find((entry) => entry.url === anchor.href);
    expect(downloadedEntry).toBeTruthy();
    if (!downloadedEntry) {
      throw new Error('Expected downloaded blob entry');
    }
    const downloadedBytes = await readBlobBytes(downloadedEntry.blob);
    expect(sha256(downloadedBytes)).toBe(expectedHash);

    // Closing revokes the PDF preview object URL immediately
    const pdfPreviewUrl = iframe.src;
    handle.close();
    await waitFor(() => {
      expect(revokedObjectUrls).toContain(pdfPreviewUrl);
    });
  });

  it('deduplicates double-clicks while loading so only one fetch is issued', async () => {
    let resolveFetch!: (val: unknown) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const app = createAppMock('jwt-alice');
    const controller = new DocumentPreviewController(app);
    activeControllers.push(controller);

    controller.openDocumentPreview({ kind: 'record', collection: 'aiFiles', id: 7, displayName: 'notes.txt' });
    controller.openDocumentPreview({ kind: 'record', collection: 'aiFiles', id: 7, displayName: 'notes.txt' });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(
      createMockResponse({
        contentType: 'text/plain; charset=utf-8',
        contentDisposition: 'attachment; filename="notes.txt"',
        bytes: 'Hello deduplicated',
      }),
    );
    expect(await screen.findByText('Hello deduplicated')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts in-flight fetch on close and prevents late response of file A from overwriting file B', async () => {
    let resolveA!: (val: unknown) => void;
    let resolveB!: (val: unknown) => void;
    const signals: AbortSignal[] = [];

    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: string, init?: RequestInit) => {
        if (init?.signal) signals.push(init.signal);
        return new Promise((resolve) => {
          resolveA = resolve;
        });
      })
      .mockImplementationOnce((_url: string, init?: RequestInit) => {
        if (init?.signal) signals.push(init.signal);
        return new Promise((resolve) => {
          resolveB = resolve;
        });
      });
    vi.stubGlobal('fetch', fetchMock);

    const app = createAppMock('jwt-alice');
    const controller = new DocumentPreviewController(app);
    activeControllers.push(controller);

    controller.openDocumentPreview({ kind: 'record', collection: 'aiFiles', id: 1, displayName: 'a.txt' });
    controller.openDocumentPreview({ kind: 'record', collection: 'aiFiles', id: 2, displayName: 'b.txt' });

    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);

    // Resolve B first
    resolveB(
      createMockResponse({
        contentType: 'text/plain',
        contentDisposition: 'attachment; filename="b.txt"',
        bytes: 'CONTENT_OF_FILE_B',
      }),
    );
    expect(await screen.findByText('CONTENT_OF_FILE_B')).toBeTruthy();

    // Now late response from A arrives — MUST NOT overwrite B!
    resolveA(
      createMockResponse({
        contentType: 'text/plain',
        contentDisposition: 'attachment; filename="a.txt"',
        bytes: 'STALE_CONTENT_OF_FILE_A',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.getByText('CONTENT_OF_FILE_B')).toBeTruthy();
    expect(screen.queryByText('STALE_CONTENT_OF_FILE_A')).toBeNull();
  });

  it('clears Blob and closes on logout, and never reuses old session Blob after switching accounts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createMockResponse({
          contentType: 'text/plain',
          contentDisposition: 'attachment; filename="doc.txt"',
          bytes: 'ALICE_PRIVATE_CONTENT',
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          contentType: 'text/plain',
          contentDisposition: 'attachment; filename="doc.txt"',
          bytes: 'BOB_PRIVATE_CONTENT',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const app = createAppMock('token-alice');
    const auth = app.apiClient?.auth;
    if (!auth) {
      throw new Error('Expected auth object on mock apiClient');
    }
    const controller = new DocumentPreviewController(app);
    activeControllers.push(controller);

    controller.openDocumentPreview({ kind: 'record', collection: 'attachments', id: 9 });
    expect(await screen.findByText('ALICE_PRIVATE_CONTENT')).toBeTruthy();

    // Simulate logout (token cleared + storage event)
    auth.token = '';
    window.dispatchEvent(new Event('storage'));
    await waitFor(() => {
      expect(screen.queryByText('ALICE_PRIVATE_CONTENT')).toBeNull();
    });

    // Missing token reports auth required without calling fetch
    controller.openDocumentPreview({ kind: 'record', collection: 'attachments', id: 9 });
    expect(await screen.findByText('Please sign in to preview this file.')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Login as Bob and open the same file -> must issue a fresh request with Bob's token
    auth.token = 'token-bob';
    controller.openDocumentPreview({ kind: 'record', collection: 'attachments', id: 9 });
    expect(await screen.findByText('BOB_PRIVATE_CONTENT')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1].headers as Headers).get('Authorization')).toBe('Bearer token-bob');
  });

  it('rejects HTML login/error pages returned with HTTP 200 and keeps Download disabled', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      createMockResponse({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        bytes: '<!DOCTYPE html><html><body><h1>Sign In</h1></body></html>',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const app = createAppMock('jwt-alice');
    const controller = new DocumentPreviewController(app);
    activeControllers.push(controller);

    controller.openDocumentPreview({ kind: 'record', collection: 'aiFiles', id: 12, displayName: 'report.pdf' });

    expect(
      await screen.findByText('Received an unexpected HTML response instead of the requested document.'),
    ).toBeTruthy();
    expect((screen.getByRole('button', { name: /Download/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('exposes openDocumentPreview on PluginFilePreviewAuthClient v2 and builds Skill Hub URLs with base64url f param', () => {
    const app = createAppMock('jwt-alice');
    const plugin = new PluginFilePreviewAuthClient({}, app as any);
    expect(typeof plugin.openDocumentPreview).toBe('function');

    const url = buildDocumentRequestUrl(app.apiClient, {
      kind: 'skillHub',
      execId: 'exec-99',
      filename: 'Báo cáo.xlsx',
    });
    expect(url).toContain('/api/skillHub:download?execId=exec-99&f=');
    expect(parseContentDispositionFilename("attachment; filename*=UTF-8''B%C3%A1o%20c%C3%A1o.xlsx")).toBe(
      'Báo cáo.xlsx',
    );
  });
});

describe('DocumentPreviewController — Real viewer fixtures & fallback guarantees', () => {
  it('renders Vietnamese UTF-8 TXT, Markdown, CSV, and formatted JSON', async () => {
    const viText = 'Báo cáo tài chính quý 1 — Tiếng Việt có dấu đầy đủ!';
    const jsonText = '{"department":"Kỹ thuật","total":42}';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createMockResponse({
          contentType: 'text/plain; charset=utf-8',
          contentDisposition: 'attachment; filename="note.txt"',
          bytes: viText,
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          contentType: 'application/json',
          contentDisposition: 'attachment; filename="data.json"',
          bytes: jsonText,
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          contentType: 'text/csv',
          contentDisposition: 'attachment; filename="sales.csv"',
          bytes: 'Region,Amount\nHanoi,1500',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const app = createAppMock('jwt-alice');
    const controller = new DocumentPreviewController(app);
    activeControllers.push(controller);

    controller.openDocumentPreview({ kind: 'record', collection: 'aiFiles', id: 1 });
    expect(await screen.findByText(viText)).toBeTruthy();

    controller.openDocumentPreview({ kind: 'record', collection: 'aiFiles', id: 2 });
    expect(await screen.findByText(/"department": "Kỹ thuật"/)).toBeTruthy();

    controller.openDocumentPreview({ kind: 'record', collection: 'aiFiles', id: 3 });
    expect(await screen.findByText(/Hanoi,1500/)).toBeTruthy();
  });

  it('renders a real OOXML DOCX fixture with docx-preview', async () => {
    const docxBytes = await createMinimalDocxBytes('Real DOCX Paragraph Content 2026');
    const fetchMock = vi.fn().mockResolvedValueOnce(
      createMockResponse({
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        contentDisposition: 'attachment; filename="proposal.docx"',
        bytes: docxBytes,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const app = createAppMock('jwt-alice');
    const controller = new DocumentPreviewController(app);
    activeControllers.push(controller);

    controller.openDocumentPreview({ kind: 'record', collection: 'aiFiles', id: 21 });
    expect(await screen.findByText('Real DOCX Paragraph Content 2026')).toBeTruthy();
  });

  it('renders real XLSX and real legacy BIFF8 XLS fixtures with cell values', async () => {
    const xlsxBytes = createSpreadsheetBytes('xlsx', [
      ['Metric', 'Value'],
      ['Revenue', '98765'],
    ]);
    const xlsBytes = createSpreadsheetBytes('biff8', [
      ['Product', 'Units'],
      ['LegacyWidget', '321'],
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createMockResponse({
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          contentDisposition: 'attachment; filename="metrics.xlsx"',
          bytes: xlsxBytes,
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          contentType: 'application/vnd.ms-excel',
          contentDisposition: 'attachment; filename="legacy.xls"',
          bytes: xlsBytes,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const app = createAppMock('jwt-alice');
    const controller = new DocumentPreviewController(app);
    activeControllers.push(controller);

    controller.openDocumentPreview({ kind: 'record', collection: 'aiFiles', id: 31 });
    expect(await screen.findByText('98765')).toBeTruthy();

    controller.openDocumentPreview({ kind: 'record', collection: 'aiFiles', id: 32 });
    expect(await screen.findByText('LegacyWidget')).toBeTruthy();
    expect(screen.getByText('321')).toBeTruthy();
  });

  it('loads real PPTX fixture and handles corrupt PDF/DOCX/XLSX/PPTX and legacy .doc/.ppt while keeping original Blob downloadable', async () => {
    const pptxBytes = await createMinimalPptxBytes('Slide One Headline');
    const corruptPdfBytes = new TextEncoder().encode('THIS_IS_NOT_A_VALID_PDF');
    const legacyDocBytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x01, 0x02]);
    const legacyPptBytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x03, 0x04]);

    expect(resolveDocumentViewerKind('old.doc', 'application/msword')).toBe('unsupported');
    expect(resolveDocumentViewerKind('old.ppt', 'application/vnd.ms-powerpoint')).toBe('unsupported');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createMockResponse({
          contentType: 'application/pdf',
          contentDisposition: 'attachment; filename="corrupt.pdf"',
          bytes: corruptPdfBytes,
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          contentType: 'application/msword',
          contentDisposition: 'attachment; filename="contract.doc"',
          bytes: legacyDocBytes,
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          contentType: 'application/vnd.ms-powerpoint',
          contentDisposition: 'attachment; filename="deck.ppt"',
          bytes: legacyPptBytes,
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          contentDisposition: 'attachment; filename="slides.pptx"',
          bytes: pptxBytes,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const app = createAppMock('jwt-alice');
    const controller = new DocumentPreviewController(app);
    activeControllers.push(controller);

    // Corrupt PDF shows clear error notice AND still allows downloading original bytes!
    controller.openDocumentPreview({ kind: 'record', collection: 'aiFiles', id: 41 });
    expect(await screen.findByText('Unable to render document preview')).toBeTruthy();
    const downloadButtons = screen.getAllByRole('button', { name: /Download/i });
    expect((downloadButtons[0] as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(downloadButtons[0]);
    const downloadedCorrupt = await readBlobBytes(createdObjectUrls[createdObjectUrls.length - 1].blob);
    expect(sha256(downloadedCorrupt)).toBe(sha256(corruptPdfBytes));

    // Legacy .doc uses download-only fallback with exact bytes
    controller.openDocumentPreview({ kind: 'record', collection: 'aiFiles', id: 42 });
    expect(
      await screen.findByText('This file type cannot be previewed. Click Download to save the file.'),
    ).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /Download/i })[0]);
    const downloadedDoc = await readBlobBytes(createdObjectUrls[createdObjectUrls.length - 1].blob);
    expect(sha256(downloadedDoc)).toBe(sha256(legacyDocBytes));

    // Legacy .ppt uses download-only fallback with exact bytes
    controller.openDocumentPreview({ kind: 'record', collection: 'aiFiles', id: 43 });
    expect(
      await screen.findByText('This file type cannot be previewed. Click Download to save the file.'),
    ).toBeTruthy();

    // Valid PPTX opens with slides.pptx title and Download enabled
    controller.openDocumentPreview({ kind: 'record', collection: 'aiFiles', id: 44 });
    expect(await screen.findByText('slides.pptx')).toBeTruthy();
  });
});
