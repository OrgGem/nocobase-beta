// SPDX-License-Identifier: Apache-2.0

import { toPdfBlob } from './previewHelpers';

export type DocumentPreviewRecordCollection = 'aiFiles' | 'attachments';

export type DocumentPreviewSource =
  | {
      kind: 'record';
      collection: DocumentPreviewRecordCollection;
      id: string | number;
      displayName?: string;
    }
  | {
      kind: 'skillHub';
      execId: string;
      filename: string;
      displayName?: string;
    };

export interface DocumentPreviewHandle {
  close: () => void;
}

export interface DocumentPreviewApiClientLike {
  appName?: string;
  auth?: {
    token?: string | null;
    role?: string | null;
    locale?: string | null;
    authenticator?: string | null;
  };
  axios?: {
    defaults?: {
      baseURL?: string;
    };
  };
  getHeaders?: () => Record<string, string | undefined>;
}

export interface DocumentPreviewI18nLike {
  t: (key: string, options?: Record<string, unknown>) => string;
}

export interface DocumentPreviewAppLike {
  name?: string;
  apiClient?: DocumentPreviewApiClientLike;
  i18n?: DocumentPreviewI18nLike;
}

export type DocumentViewerKind = 'pdf' | 'text' | 'docx' | 'xlsx' | 'pptx' | 'unsupported';

export type DocumentPreviewErrorCode =
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'UNEXPECTED_HTML'
  | 'INVALID_SOURCE'
  | 'FETCH_FAILED';

export class DocumentPreviewError extends Error {
  readonly code: DocumentPreviewErrorCode;
  readonly status?: number;

  constructor(code: DocumentPreviewErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'DocumentPreviewError';
    this.code = code;
    this.status = status;
  }
}

export interface LoadedDocument {
  blob: Blob;
  filename: string;
  mimeType: string;
  viewerKind: DocumentViewerKind;
  headerBytes: Uint8Array;
}

const SUPPORTED_COLLECTIONS = new Set<DocumentPreviewRecordCollection>(['aiFiles', 'attachments']);

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'log', 'xml', 'yaml', 'yml']);
const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'text/json',
  'application/xml',
  'text/xml',
  'text/yaml',
  'application/x-yaml',
]);
const DOCX_MIME_TYPES = new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
const XLSX_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);
const PPTX_MIME_TYPES = new Set(['application/vnd.openxmlformats-officedocument.presentationml.presentation']);
const LEGACY_UNSUPPORTED_OFFICE_EXTENSIONS = new Set(['doc', 'ppt']);
const LEGACY_UNSUPPORTED_OFFICE_MIME_TYPES = new Set(['application/msword', 'application/vnd.ms-powerpoint']);

export function getDocumentSourceKey(source: DocumentPreviewSource): string {
  if (source.kind === 'record') {
    return `record:${source.collection}:${String(source.id).trim()}`;
  }
  return `skillHub:${source.execId.trim()}:${source.filename.trim()}`;
}

export function getDocumentInitialTitle(source: DocumentPreviewSource): string {
  if (source.displayName && source.displayName.trim()) {
    return source.displayName.trim();
  }
  if (source.kind === 'skillHub' && source.filename.trim()) {
    return source.filename.trim();
  }
  return 'Document';
}

export function encodeBase64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function resolveApiActionUrl(apiClient: DocumentPreviewApiClientLike | undefined, actionPath: string): string {
  const rawBase = apiClient?.axios?.defaults?.baseURL;
  const trimmedBase = typeof rawBase === 'string' && rawBase.trim() ? rawBase.trim().replace(/\/+$/, '') : '/api';
  const trimmedPath = actionPath.replace(/^\/+/, '');
  return `${trimmedBase}/${trimmedPath}`;
}

export function buildDocumentRequestUrl(
  apiClient: DocumentPreviewApiClientLike | undefined,
  source: DocumentPreviewSource,
): string {
  if (source.kind === 'record') {
    if (!SUPPORTED_COLLECTIONS.has(source.collection)) {
      throw new DocumentPreviewError('INVALID_SOURCE', `Unsupported collection: ${String(source.collection)}`);
    }
    const id = String(source.id ?? '').trim();
    if (!id || id.includes('/') || id.startsWith('http://') || id.startsWith('https://')) {
      throw new DocumentPreviewError('INVALID_SOURCE', 'Invalid document record id');
    }
    const params = new URLSearchParams({
      collection: source.collection,
      id,
    });
    return resolveApiActionUrl(apiClient, `filePreviewAuth:streamDocument?${params.toString()}`);
  }

  if (source.kind === 'skillHub') {
    const execId = String(source.execId ?? '').trim();
    const filename = String(source.filename ?? '').trim();
    if (!execId || !filename) {
      throw new DocumentPreviewError('INVALID_SOURCE', 'Missing Skill Hub execId or filename');
    }
    const params = new URLSearchParams({
      execId,
      f: encodeBase64UrlUtf8(filename),
    });
    return resolveApiActionUrl(apiClient, `skillHub:download?${params.toString()}`);
  }

  throw new DocumentPreviewError('INVALID_SOURCE', 'Unsupported document preview source');
}

export function getCurrentAuthToken(apiClient: DocumentPreviewApiClientLike | undefined): string {
  const direct = apiClient?.auth?.token;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }
  const rawHeaders = apiClient?.getHeaders?.();
  const authHeader = rawHeaders?.Authorization || rawHeaders?.authorization;
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  return '';
}

export function buildDocumentRequestHeaders(apiClient: DocumentPreviewApiClientLike | undefined): {
  headers: Headers;
  token: string;
} {
  const headers = new Headers();
  const clientHeaders = apiClient?.getHeaders?.() || {};
  for (const [key, value] of Object.entries(clientHeaders)) {
    if (typeof value === 'string' && value.trim()) {
      headers.set(key, value);
    }
  }

  const token = getCurrentAuthToken(apiClient);
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (apiClient?.auth?.role && !headers.has('X-Role')) {
    headers.set('X-Role', apiClient.auth.role);
  }
  if (apiClient?.auth?.locale && !headers.has('X-Locale')) {
    headers.set('X-Locale', apiClient.auth.locale);
  }
  if (apiClient?.auth?.authenticator && !headers.has('X-Authenticator')) {
    headers.set('X-Authenticator', apiClient.auth.authenticator);
  }
  if (apiClient?.appName && !headers.has('X-App')) {
    headers.set('X-App', apiClient.appName);
  }

  return { headers, token };
}

function sanitizeDownloadFilename(raw: string): string {
  const cleaned = raw
    .replace(/[\r\n\0]/g, '')
    .replace(/^.*[/\\]/, '')
    .trim();
  return cleaned;
}

export function parseContentDispositionFilename(headerValue: string | null | undefined): string {
  if (!headerValue) {
    return '';
  }

  const extMatch = headerValue.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;\r\n]+)/i);
  if (extMatch?.[1]) {
    const rawValue = extMatch[1].trim().replace(/^"(.*)"$/, '$1');
    try {
      const decoded = decodeURIComponent(rawValue);
      const sanitized = sanitizeDownloadFilename(decoded);
      if (sanitized) return sanitized;
    } catch {
      const sanitized = sanitizeDownloadFilename(rawValue);
      if (sanitized) return sanitized;
    }
  }

  const quotedMatch = headerValue.match(/filename\s*=\s*"([^"]+)"/i);
  if (quotedMatch?.[1]) {
    const sanitized = sanitizeDownloadFilename(quotedMatch[1]);
    if (sanitized) return sanitized;
  }

  const bareMatch = headerValue.match(/filename\s*=\s*([^;\r\n]+)/i);
  if (bareMatch?.[1]) {
    const sanitized = sanitizeDownloadFilename(bareMatch[1]);
    if (sanitized) return sanitized;
  }

  return '';
}

export function getExtensionFromFilename(filename: string): string {
  const clean = filename.split('?')[0].split('#')[0].trim();
  const dotIndex = clean.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === clean.length - 1) {
    return '';
  }
  return clean.slice(dotIndex + 1).toLowerCase();
}

export function resolveDocumentViewerKind(filename: string, mimeType: string): DocumentViewerKind {
  const ext = getExtensionFromFilename(filename);
  const normalizedMime = mimeType.split(';')[0].trim().toLowerCase();

  if (LEGACY_UNSUPPORTED_OFFICE_EXTENSIONS.has(ext) || LEGACY_UNSUPPORTED_OFFICE_MIME_TYPES.has(normalizedMime)) {
    return 'unsupported';
  }

  if (ext === 'pdf' || normalizedMime === 'application/pdf') {
    return 'pdf';
  }

  if (ext === 'docx' || DOCX_MIME_TYPES.has(normalizedMime)) {
    return 'docx';
  }

  if (ext === 'xlsx' || ext === 'xls' || XLSX_MIME_TYPES.has(normalizedMime)) {
    return 'xlsx';
  }

  if (ext === 'pptx' || PPTX_MIME_TYPES.has(normalizedMime)) {
    return 'pptx';
  }

  if (TEXT_EXTENSIONS.has(ext) || TEXT_MIME_TYPES.has(normalizedMime)) {
    return 'text';
  }

  return 'unsupported';
}

export async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return await new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(new Uint8Array(reader.result as ArrayBuffer));
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob bytes'));
    reader.readAsArrayBuffer(blob);
  });
}

export async function readBlobHeaderBytes(blob: Blob, maxLength = 1024): Promise<Uint8Array> {
  const slice = typeof blob.slice === 'function' ? blob.slice(0, maxLength) : blob;
  return readBlobBytes(slice);
}

export function isUnexpectedHtmlResponse(
  contentType: string,
  headerBytes: Uint8Array,
  viewerKind: DocumentViewerKind,
): boolean {
  const normalizedMime = contentType.split(';')[0].trim().toLowerCase();
  if (normalizedMime === 'text/html' || normalizedMime === 'application/xhtml+xml') {
    return true;
  }

  // Binary documents (PDF, Office, unknown binary) should never begin with an HTML document prologue.
  if (viewerKind !== 'text') {
    const sample = new TextDecoder('utf-8', { fatal: false }).decode(headerBytes).trimStart().toLowerCase();
    if (sample.startsWith('<!doctype html') || sample.startsWith('<html')) {
      return true;
    }
  }

  return false;
}

export function hasPdfMagicHeader(headerBytes: Uint8Array): boolean {
  const sample = new TextDecoder('latin1').decode(headerBytes);
  return sample.includes('%PDF-');
}

export function hasZipMagicHeader(headerBytes: Uint8Array): boolean {
  return headerBytes.length >= 4 && headerBytes[0] === 0x50 && headerBytes[1] === 0x4b;
}

export function createDocumentPreviewPdfUrl(blob: Blob): string {
  return URL.createObjectURL(toPdfBlob(blob));
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const safeName = sanitizeDownloadFilename(filename) || 'document';
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = safeName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export async function fetchDocumentBlob(
  apiClient: DocumentPreviewApiClientLike | undefined,
  source: DocumentPreviewSource,
  signal?: AbortSignal,
): Promise<LoadedDocument> {
  const { headers, token } = buildDocumentRequestHeaders(apiClient);
  if (!token) {
    throw new DocumentPreviewError('AUTH_REQUIRED', 'Please sign in to preview this file.', 401);
  }

  const url = buildDocumentRequestUrl(apiClient, source);
  const response = await fetch(url, {
    method: 'GET',
    headers,
    credentials: 'include',
    signal,
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new DocumentPreviewError('AUTH_REQUIRED', 'Please sign in to preview this file.', 401);
    }
    if (response.status === 403) {
      throw new DocumentPreviewError('FORBIDDEN', 'You do not have permission to access this file.', 403);
    }
    if (response.status === 404) {
      throw new DocumentPreviewError('NOT_FOUND', 'File not found.', 404);
    }
    throw new DocumentPreviewError(
      'FETCH_FAILED',
      `Failed to fetch file: ${response.status} ${response.statusText || ''}`.trim(),
      response.status,
    );
  }

  const contentType = response.headers?.get?.('content-type') || '';
  const contentDisposition = response.headers?.get?.('content-disposition') || '';
  const serverFilename = parseContentDispositionFilename(contentDisposition);
  const fallbackFilename = source.kind === 'skillHub' ? source.filename : source.displayName || 'document';
  const filename = serverFilename || sanitizeDownloadFilename(fallbackFilename) || 'document';

  const blob = await response.blob();
  const effectiveMime = contentType.split(';')[0].trim().toLowerCase() || (blob.type || '').toLowerCase();
  const viewerKind = resolveDocumentViewerKind(filename, effectiveMime);
  const headerBytes = await readBlobHeaderBytes(blob, 1024);

  if (isUnexpectedHtmlResponse(contentType || blob.type || '', headerBytes, viewerKind)) {
    throw new DocumentPreviewError(
      'UNEXPECTED_HTML',
      'Received an unexpected HTML response instead of the requested document.',
      response.status,
    );
  }

  return {
    blob,
    filename,
    mimeType: effectiveMime,
    viewerKind,
    headerBytes,
  };
}
