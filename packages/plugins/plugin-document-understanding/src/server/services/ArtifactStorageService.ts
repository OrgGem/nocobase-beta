// SPDX-License-Identifier: Apache-2.0

import * as crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { basename, extname, resolve, sep } from 'path';
import type { Database } from '@nocobase/database';
import mime from 'mime-types';
import {
  createProblem,
  expandPageRanges,
  type DuArtifactRole,
  type DuArtifactState,
  type PageSelectionSpec,
  type ProblemDetails,
} from '../contracts/du-contracts';

export class DuHttpError extends Error {
  public readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.detail || problem.title);
    this.name = 'DuHttpError';
    this.problem = problem;
  }

  get status(): number {
    return this.problem.status;
  }
}

export interface ArtifactRecord {
  id?: number;
  artifactId: string;
  tenantId: string;
  operationId?: string | null;
  role: DuArtifactRole;
  state: DuArtifactState;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  hashSha256?: string | null;
  storagePath: string;
  idempotencyKey?: string | null;
  createdById?: number | null;
}

export interface ParsedPage {
  pageNumber: number;
  text: string;
}

export interface ParsedDocument {
  artifactId: string;
  fileName: string;
  mimeType: string;
  detectedFormat: string;
  totalPageCount: number;
  selectedPages: ParsedPage[];
  markdown: string;
  text: string;
  requiresVision: boolean;
  parser: string;
}

type LoadByWorkerFn = (
  ext: string,
  options: { filePath: string; mimeType?: string; timeout?: number },
) => Promise<Array<{ pageContent: string; metadata?: Record<string, unknown> }>>;

const ARTIFACTS_COLLECTION = 'doc_understanding_artifacts';
const DEFAULT_GATEWAY_UPLOAD_MAX_BYTES = 64 * 1024 * 1024; // 64 MiB per BRD

function sanitizeSegment(raw: string, fallback: string): string {
  const cleaned = basename(raw || fallback)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, 120);
  return cleaned || fallback;
}

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function htmlToMarkdown(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, ' | $1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toPlainRecord<T>(row: unknown): T {
  if (row && typeof row === 'object' && typeof (row as { toJSON?: () => T }).toJSON === 'function') {
    return (row as { toJSON: () => T }).toJSON();
  }
  return row as T;
}

function resolveAiWorkerLoader(): LoadByWorkerFn | null {
  try {
    // Loaded lazily so pure unit tests without worker runtime stay fast and deterministic.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const aiModule = require('@nocobase/ai') as { loadByWorker?: LoadByWorkerFn };
    return typeof aiModule.loadByWorker === 'function' ? aiModule.loadByWorker : null;
  } catch {
    return null;
  }
}

export class ArtifactStorageService {
  private readonly db: Database;
  private readonly storageRoot: string;

  constructor(db: Database, customStorageRoot?: string) {
    this.db = db;
    this.storageRoot =
      customStorageRoot || resolve(process.cwd(), 'storage', 'uploads', 'doc-understanding', 'artifacts');
    mkdirSync(this.storageRoot, { recursive: true });
  }

  private assertSafeStoragePath(targetPath: string): string {
    const resolvedRoot = existsSync(this.storageRoot) ? realpathSync(this.storageRoot) : resolve(this.storageRoot);
    const resolvedTarget = resolve(targetPath);
    if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) {
      throw new DuHttpError(createProblem(403, 'PERMISSION_DENIED', 'Artifact storage path is outside allowed root'));
    }
    return resolvedTarget;
  }

  private buildArtifactPath(tenantId: string, artifactId: string, fileName: string): string {
    const safeTenant = sanitizeSegment(tenantId, 'default');
    const tenantDir = resolve(this.storageRoot, safeTenant);
    mkdirSync(tenantDir, { recursive: true });
    const safeName = sanitizeSegment(fileName, 'document.bin');
    return this.assertSafeStoragePath(resolve(tenantDir, `${artifactId}__${safeName}`));
  }

  async initiateUpload(params: {
    tenantId: string;
    fileName: string;
    mimeType?: string;
    sizeBytes: number;
    uploadToken?: string;
    idempotencyKey?: string;
    maxFileSizeBytes?: number;
    userId?: number;
    urlPrefix?: string;
  }): Promise<{
    httpStatus: 200 | 201;
    artifactId: string;
    state: DuArtifactState;
    replayed: boolean;
    uploadUrl: string;
  }> {
    const {
      tenantId,
      fileName,
      sizeBytes,
      uploadToken,
      idempotencyKey,
      maxFileSizeBytes = DEFAULT_GATEWAY_UPLOAD_MAX_BYTES,
      userId,
      urlPrefix = '/api/du/v1',
    } = params;

    if (!fileName || typeof fileName !== 'string' || !fileName.trim()) {
      throw new DuHttpError(
        createProblem(422, 'INVALID_SCHEMA', 'fileName is required', {
          errors: [{ pointer: '/fileName', message: 'Expected non-empty string' }],
        }),
      );
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
      throw new DuHttpError(
        createProblem(422, 'INVALID_SCHEMA', 'sizeBytes must be a non-negative integer', {
          errors: [{ pointer: '/sizeBytes', message: 'Expected integer >= 0' }],
        }),
      );
    }
    if (sizeBytes > maxFileSizeBytes) {
      throw new DuHttpError(
        createProblem(413, 'PAYLOAD_TOO_LARGE', `Upload size ${sizeBytes} exceeds limit ${maxFileSizeBytes} bytes`),
      );
    }

    const resolvedMime = (params.mimeType || mime.lookup(fileName) || 'application/octet-stream').toString();
    const repo = this.db.getRepository(ARTIFACTS_COLLECTION);
    const dedupKey = idempotencyKey?.trim() || uploadToken?.trim();

    if (dedupKey) {
      const existingRow = await repo.findOne({
        filter: uploadToken
          ? { tenantId, $or: [{ artifactId: uploadToken }, { idempotencyKey: dedupKey }] }
          : { tenantId, idempotencyKey: dedupKey },
      });
      if (existingRow) {
        const existing = toPlainRecord<ArtifactRecord>(existingRow);
        if (existing.fileName !== fileName || existing.mimeType !== resolvedMime) {
          throw new DuHttpError(
            createProblem(
              409,
              'IDEMPOTENCY_CONFLICT',
              'Idempotency-Key / uploadToken reused with different file metadata',
            ),
          );
        }
        return {
          httpStatus: 200,
          artifactId: existing.artifactId,
          state: existing.state,
          replayed: true,
          uploadUrl: `${urlPrefix}/uploads/${existing.artifactId}/content`,
        };
      }
    }

    const artifactId =
      uploadToken && /^[0-9a-fA-F-]{8,64}$/.test(uploadToken.trim()) ? uploadToken.trim() : crypto.randomUUID();
    const storagePath = this.buildArtifactPath(tenantId, artifactId, fileName);

    await repo.create({
      values: {
        artifactId,
        tenantId,
        role: 'input',
        state: 'UPLOADING',
        fileName: fileName.trim(),
        mimeType: resolvedMime,
        sizeBytes,
        storagePath,
        idempotencyKey: dedupKey || null,
        createdById: userId ?? null,
      },
    });

    return {
      httpStatus: 201,
      artifactId,
      state: 'UPLOADING',
      replayed: false,
      uploadUrl: `${urlPrefix}/uploads/${artifactId}/content`,
    };
  }

  async writeUploadContent(params: {
    tenantId: string;
    artifactId: string;
    buffer: Buffer;
    expectedSha256?: string;
    maxFileSizeBytes?: number;
  }): Promise<{
    httpStatus: 200 | 201;
    artifactId: string;
    state: 'READY';
    sizeBytes: number;
    hashSha256: string;
    replayed: boolean;
  }> {
    const {
      tenantId,
      artifactId,
      buffer,
      expectedSha256,
      maxFileSizeBytes = DEFAULT_GATEWAY_UPLOAD_MAX_BYTES,
    } = params;

    if (buffer.length > maxFileSizeBytes) {
      throw new DuHttpError(
        createProblem(
          413,
          'PAYLOAD_TOO_LARGE',
          `Payload size ${buffer.length} exceeds limit ${maxFileSizeBytes} bytes`,
        ),
      );
    }

    const repo = this.db.getRepository(ARTIFACTS_COLLECTION);
    const row = await repo.findOne({ filter: { tenantId, artifactId } });
    if (!row) {
      throw new DuHttpError(createProblem(404, 'NOT_FOUND', `Upload session ${artifactId} not found`));
    }

    const record = toPlainRecord<ArtifactRecord>(row);
    if (record.state === 'ABORTED') {
      throw new DuHttpError(createProblem(409, 'STATE_CONFLICT', 'Upload session has already been aborted'));
    }

    const actualSha256 = sha256Hex(buffer);
    if (expectedSha256 && expectedSha256.trim().toLowerCase() !== actualSha256) {
      throw new DuHttpError(createProblem(422, 'CHECKSUM_MISMATCH', 'x-content-sha256 does not match uploaded bytes'));
    }

    if (record.state === 'READY') {
      if (record.hashSha256 && record.hashSha256 !== actualSha256) {
        throw new DuHttpError(
          createProblem(409, 'IDEMPOTENCY_CONFLICT', 'Artifact content already finalized with a different digest'),
        );
      }
      return {
        httpStatus: 200,
        artifactId,
        state: 'READY',
        sizeBytes: record.sizeBytes,
        hashSha256: actualSha256,
        replayed: true,
      };
    }

    const safePath = this.assertSafeStoragePath(record.storagePath);
    mkdirSync(resolve(safePath, '..'), { recursive: true });
    writeFileSync(safePath, buffer);

    await repo.update({
      filter: { tenantId, artifactId },
      values: {
        state: 'READY',
        sizeBytes: buffer.length,
        hashSha256: actualSha256,
      },
    });

    return {
      httpStatus: 201,
      artifactId,
      state: 'READY',
      sizeBytes: buffer.length,
      hashSha256: actualSha256,
      replayed: false,
    };
  }

  async completeUpload(
    tenantId: string,
    artifactId: string,
  ): Promise<{ artifactId: string; state: DuArtifactState; replayed: boolean }> {
    const record = await this.getArtifactOrThrow(tenantId, artifactId);
    if (record.state !== 'READY') {
      throw new DuHttpError(
        createProblem(409, 'STATE_CONFLICT', `Artifact ${artifactId} cannot complete from state ${record.state}`),
      );
    }
    return { artifactId, state: 'READY', replayed: true };
  }

  async abortUpload(tenantId: string, artifactId: string): Promise<{ artifactId: string; state: 'ABORTED' }> {
    const repo = this.db.getRepository(ARTIFACTS_COLLECTION);
    const record = await this.getArtifactOrThrow(tenantId, artifactId);
    if (record.state === 'READY') {
      throw new DuHttpError(createProblem(409, 'STATE_CONFLICT', 'Cannot abort an already READY artifact'));
    }
    try {
      const safePath = this.assertSafeStoragePath(record.storagePath);
      if (existsSync(safePath)) {
        rmSync(safePath, { force: true });
      }
    } catch {
      // Ignore file removal errors on partial uploads
    }
    await repo.update({
      filter: { tenantId, artifactId },
      values: { state: 'ABORTED' },
    });
    return { artifactId, state: 'ABORTED' };
  }

  async createReadyArtifactFromBuffer(params: {
    tenantId: string;
    fileName: string;
    mimeType?: string;
    buffer: Buffer;
    role?: DuArtifactRole;
    operationId?: string;
    userId?: number;
  }): Promise<ArtifactRecord> {
    const artifactId = crypto.randomUUID();
    const resolvedMime = (params.mimeType || mime.lookup(params.fileName) || 'application/octet-stream').toString();
    const storagePath = this.buildArtifactPath(params.tenantId, artifactId, params.fileName);
    const hashSha256 = sha256Hex(params.buffer);
    writeFileSync(storagePath, params.buffer);

    const values: ArtifactRecord = {
      artifactId,
      tenantId: params.tenantId,
      operationId: params.operationId ?? null,
      role: params.role || 'input',
      state: 'READY',
      fileName: params.fileName,
      mimeType: resolvedMime,
      sizeBytes: params.buffer.length,
      hashSha256,
      storagePath,
      createdById: params.userId ?? null,
    };

    const created = await this.db.getRepository(ARTIFACTS_COLLECTION).create({ values });
    return toPlainRecord<ArtifactRecord>(created);
  }

  async createJsonOutputArtifact(params: {
    tenantId: string;
    operationId: string;
    fileName?: string;
    payload: unknown;
    userId?: number;
  }): Promise<ArtifactRecord> {
    const serialized = Buffer.from(JSON.stringify(params.payload, null, 2), 'utf8');
    return this.createReadyArtifactFromBuffer({
      tenantId: params.tenantId,
      operationId: params.operationId,
      role: 'output',
      fileName: params.fileName || `${params.operationId}.result.json`,
      mimeType: 'application/json',
      buffer: serialized,
      userId: params.userId,
    });
  }

  async getArtifactOrThrow(tenantId: string, artifactId: string): Promise<ArtifactRecord> {
    const row = await this.db.getRepository(ARTIFACTS_COLLECTION).findOne({
      filter: { tenantId, artifactId },
    });
    if (!row) {
      throw new DuHttpError(createProblem(404, 'NOT_FOUND', `Artifact ${artifactId} not found`));
    }
    return toPlainRecord<ArtifactRecord>(row);
  }

  readArtifactBuffer(record: ArtifactRecord): Buffer {
    if (record.state !== 'READY') {
      throw new DuHttpError(
        createProblem(
          409,
          'STATE_CONFLICT',
          `Artifact ${record.artifactId} is in state ${record.state}, expected READY`,
        ),
      );
    }
    const safePath = this.assertSafeStoragePath(record.storagePath);
    if (!existsSync(safePath)) {
      throw new DuHttpError(createProblem(404, 'NOT_FOUND', `Artifact ${record.artifactId} blob missing from storage`));
    }
    return readFileSync(safePath);
  }

  /**
   * Local Document Kit: parses digital documents (PDF, DOCX, XLSX, PPTX, CSV, TXT, MD, JSON, HTML)
   * into per-page text/Markdown and applies DI-06 page selection when requested.
   */
  async parseArtifactPages(
    record: ArtifactRecord,
    selection: PageSelectionSpec = { kind: 'all' },
  ): Promise<ParsedDocument> {
    const buffer = this.readArtifactBuffer(record);
    const ext = (extname(record.fileName) || `.${mime.extension(record.mimeType) || 'txt'}`).toLowerCase();
    const isImage =
      record.mimeType.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff'].includes(ext);

    if (isImage) {
      const pages: ParsedPage[] = [{ pageNumber: 1, text: '' }];
      const selectedNums = expandPageRanges(selection, 1);
      return {
        artifactId: record.artifactId,
        fileName: record.fileName,
        mimeType: record.mimeType,
        detectedFormat: ext.replace(/^\./, '') || 'image',
        totalPageCount: 1,
        selectedPages: pages.filter((p) => selectedNums.includes(p.pageNumber)),
        markdown: '',
        text: '',
        requiresVision: true,
        parser: 'image-vision-candidate',
      };
    }

    let pages: ParsedPage[] = [];
    let parserName = 'local-text';
    let requiresVision = false;

    if (ext === '.html' || ext === '.htm' || record.mimeType === 'text/html') {
      const md = htmlToMarkdown(buffer.toString('utf8'));
      pages = [{ pageNumber: 1, text: md }];
      parserName = 'local-html';
    } else if (ext === '.json' || record.mimeType === 'application/json') {
      const raw = buffer.toString('utf8');
      let formatted = raw;
      try {
        formatted = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        // Keep raw text when malformed JSON is inspected
      }
      pages = [{ pageNumber: 1, text: formatted }];
      parserName = 'local-json';
    } else if (
      ['.txt', '.md'].includes(ext) ||
      record.mimeType.startsWith('text/plain') ||
      record.mimeType === 'text/markdown'
    ) {
      const raw = buffer.toString('utf8');
      const formFeedPages = raw.split('\f');
      pages = formFeedPages.map((content, idx) => ({ pageNumber: idx + 1, text: content.trim() }));
      if (pages.length === 0) pages = [{ pageNumber: 1, text: '' }];
      parserName = 'local-text';
    } else {
      const workerLoader = resolveAiWorkerLoader();
      const safePath = this.assertSafeStoragePath(record.storagePath);
      if (workerLoader && ['.pdf', '.docx', '.doc', '.pptx', '.xlsx', '.xls', '.xlsm', '.csv'].includes(ext)) {
        try {
          const docs = await workerLoader(ext, {
            filePath: safePath,
            mimeType: record.mimeType,
            timeout: 60_000,
          });
          if (docs.length > 0) {
            pages = docs.map((doc, idx) => {
              const loc = doc.metadata?.loc as { pageNumber?: number } | undefined;
              const pageNumber = typeof loc?.pageNumber === 'number' ? loc.pageNumber : idx + 1;
              return { pageNumber, text: (doc.pageContent || '').trim() };
            });
            parserName = 'nocobase-ai-worker';
          }
        } catch {
          // Fall through to lightweight fallback below
        }
      }

      if (pages.length === 0) {
        if (ext === '.csv' || record.mimeType === 'text/csv') {
          pages = [{ pageNumber: 1, text: buffer.toString('utf8').trim() }];
          parserName = 'local-csv';
        } else if (ext === '.pdf' || record.mimeType === 'application/pdf') {
          // Scanned or image-only PDF with no text layer extracted
          pages = [{ pageNumber: 1, text: '' }];
          requiresVision = true;
          parserName = 'pdf-ocr-candidate';
        } else {
          pages = [{ pageNumber: 1, text: buffer.toString('utf8').trim() }];
          parserName = 'utf8-fallback';
        }
      }
    }

    if (pages.every((p) => !p.text.trim()) && (ext === '.pdf' || record.mimeType === 'application/pdf')) {
      requiresVision = true;
    }

    const totalPageCount = Math.max(pages.length, 1);
    let selectedNums: number[];
    try {
      selectedNums = expandPageRanges(selection, totalPageCount);
    } catch (err) {
      throw new DuHttpError(
        createProblem(422, 'INVALID_SCHEMA', err instanceof Error ? err.message : String(err), {
          errors: [{ pointer: '/documentSelection', message: err instanceof Error ? err.message : String(err) }],
        }),
      );
    }

    const selectedPages = pages.filter((p) => selectedNums.includes(p.pageNumber));
    const joinedMarkdown = selectedPages
      .map((p) => (totalPageCount > 1 ? `<!-- page ${p.pageNumber} -->\n${p.text}` : p.text))
      .join('\n\n')
      .trim();
    const joinedText = selectedPages
      .map((p) => p.text)
      .join('\n\n')
      .trim();

    return {
      artifactId: record.artifactId,
      fileName: record.fileName,
      mimeType: record.mimeType,
      detectedFormat: ext.replace(/^\./, '') || 'bin',
      totalPageCount,
      selectedPages,
      markdown: joinedMarkdown,
      text: joinedText,
      requiresVision,
      parser: parserName,
    };
  }
}
