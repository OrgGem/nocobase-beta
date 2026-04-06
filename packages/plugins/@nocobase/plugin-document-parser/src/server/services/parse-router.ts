/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, unlink } from 'fs/promises';
import type { Repository } from '@nocobase/database';
import { callExternalOcr, OcrProviderConfig } from './external-ocr-client';
import type { InternalParserRegistry, AttachmentLike } from './internal-parser-registry';
import { resolveExtname, sanitizeForXmlAttr } from './utils';
import { DEFAULT_SETTINGS } from '../../shared/defaults';

export type ParsedAttachmentResult = {
  placement: string;
  content: any;
};

export type DefaultParserFn = () => Promise<ParsedAttachmentResult>;

type Settings = {
  mode: 'default' | 'internal' | 'external';
  activeProviderId?: number | string | null;
  fallbackToDefault: boolean;
  imagePassThrough: boolean;
  includedExtnames: string[];
  useDocpixie: boolean;
};

/**
 * Decides how to process each attachment:
 *
 *  1. If `imagePassThrough` is true and the file is an image → default
 *  2. If `includedExtnames` is non-empty and extname is not in the list → default
 *  3. Based on `mode`:
 *     - default  → call the original provider.parseAttachment()
 *     - internal → run through InternalParserRegistry
 *     - external → call the configured external OCR API
 *  4. On failure, if `fallbackToDefault` → call original provider as fallback
 */
export class ParseRouter {
  constructor(
    private readonly getSettingsRepo: () => Repository,
    private readonly getProvidersRepo: () => Repository,
    private readonly internalRegistry: InternalParserRegistry,
    private readonly getFileBuffer: (
      ctx: Context,
      attachment: AttachmentLike,
    ) => Promise<{ buffer: Buffer; url: string }>,
    /** Returns the docpixie plugin instance if it is loaded & active, else null */
    private readonly getDocpixiePlugin: () => any | null = () => null,
  ) {}

  // ── Settings cache (invalidated every N ms) ───────────────────────────────

  private cachedSettings: Settings | null = null;
  private settingsCachedAt = 0;
  private readonly CACHE_TTL_MS = 5_000;

  private async getSettings(): Promise<Settings> {
    const now = Date.now();
    if (this.cachedSettings && now - this.settingsCachedAt < this.CACHE_TTL_MS) {
      return this.cachedSettings;
    }

    const repo = this.getSettingsRepo();
    let record = await repo.findOne({});
    if (!record) {
      // Auto-create defaults on first access
      record = await repo.create({
        values: { ...DEFAULT_SETTINGS },
      });
    }

    this.cachedSettings = {
      mode: record.get('mode') ?? 'default',
      activeProviderId: record.get('activeProviderId') ?? null,
      fallbackToDefault: record.get('fallbackToDefault') ?? true,
      imagePassThrough: record.get('imagePassThrough') ?? true,
      includedExtnames: record.get('includedExtnames') ?? [],
      useDocpixie: record.get('useDocpixie') ?? false,
    };
    this.settingsCachedAt = now;
    return this.cachedSettings!;
  }

  /** Call after saving settings so the next request reads fresh values */
  invalidateSettingsCache(): void {
    this.cachedSettings = null;
  }

  // ── Main entry point ──────────────────────────────────────────────────────

  async route(
    ctx: Context,
    attachment: AttachmentLike,
    defaultParser: DefaultParserFn,
  ): Promise<ParsedAttachmentResult> {
    const settings = await this.getSettings();

    // 1. Always pass images through if configured
    if (settings.imagePassThrough && attachment.mimetype?.startsWith('image/')) {
      return defaultParser();
    }

    // 2. If an explicit extension whitelist is set and this file isn't in it → default
    if (settings.includedExtnames.length > 0) {
      const ext = resolveExtname(attachment);
      if (!settings.includedExtnames.includes(ext)) {
        return defaultParser();
      }
    }

    // 3. DocPixie indexing — runs BEFORE normal mode routing when enabled
    //    Indexes the document asynchronously and returns a metadata reference block
    //    so the LLM uses docpixie:query tool instead of reading raw file content.
    if (settings.useDocpixie) {
      const docpixieResult = await this.routeDocpixie(ctx, attachment);
      if (docpixieResult) return docpixieResult;
      // docpixie unavailable/failed — fall through to normal routing
    }

    // 4. Route based on mode
    switch (settings.mode) {
      case 'default':
        return defaultParser();

      case 'internal':
        return this.routeInternal(ctx, attachment, settings, defaultParser);

      case 'external':
        return this.routeExternal(ctx, attachment, settings, defaultParser);

      default:
        return defaultParser();
    }
  }

  // ── DocPixie routing ─────────────────────────────────────────────────────

  /**
   * Index the attachment into DocPixie and return a metadata reference block.
   *
   * Strategy:
   *   1. Get the DocPixie plugin instance (returns null if not loaded/active)
   *   2. Download the file buffer and write to a temp file (works for S3 / local)
   *   3. Call docpixieService.processDocument() — this:
   *        a. Creates a DB record immediately → returns documentId fast
   *        b. Continues extracting pages + summarizing in the background
   *   4. Build a content block with metadata + LLM instructions to use docpixie:query
   *   5. Clean up temp file
   *
   * Returns null if DocPixie is unavailable or not ready so caller can fall through.
   */
  private async routeDocpixie(ctx: Context, attachment: AttachmentLike): Promise<ParsedAttachmentResult | null> {
    const docpixiePlugin = this.getDocpixiePlugin();
    if (!docpixiePlugin?.service) {
      return null;
    }

    const service = docpixiePlugin.service;
    if (!service.isReady()) {
      ctx.log?.warn?.('[DocumentParser] DocPixie service is not ready (not configured) — skipping');
      return null;
    }

    const filename = attachment.filename ?? attachment.name ?? 'document';
    const mimetype = attachment.mimetype ?? 'application/octet-stream';
    let tempPath: string | null = null;

    try {
      // Download file bytes (handles S3 URLs and local paths uniformly)
      const { buffer } = await this.getFileBuffer(ctx, attachment);

      // Write to a uniquely-named temp file so DocPixie can read it by path
      const ext = resolveExtname(attachment) || '.bin';
      tempPath = join(tmpdir(), `docparser-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
      await writeFile(tempPath, buffer);

      // Kick off DocPixie indexing — processDocument creates the DB record fast
      // and continues ingestion (OCR + LLM summarization) asynchronously
      const documentId: number = await service.processDocument(tempPath, { name: filename });

      ctx.log?.info?.(`[DocumentParser] DocPixie indexing started: documentId=${documentId} file="${filename}"`);

      return docpixieReferenceBlock(documentId, filename, mimetype);
    } catch (err) {
      ctx.log?.warn?.(`[DocumentParser] DocPixie indexing failed for "${filename}": ${err}`);
      return null; // fall through to normal routing
    } finally {
      // Clean up temp file (best-effort — DocPixie has already read it)
      if (tempPath) {
        unlink(tempPath).catch(() => {});
      }
    }
  }

  // ── Internal routing ──────────────────────────────────────────────────────

  private async routeInternal(
    ctx: Context,
    attachment: AttachmentLike,
    settings: Settings,
    defaultParser: DefaultParserFn,
  ): Promise<ParsedAttachmentResult> {
    try {
      const result = await this.internalRegistry.parse(attachment, ctx);

      if (!result.handled) {
        // No handler claimed this file type; fall through
        return settings.fallbackToDefault ? defaultParser() : this.unsupportedResult(attachment);
      }

      return textToContentBlock(result.text, attachment);
    } catch (err) {
      ctx.log?.warn?.(`[DocumentParser] internal parse failed for "${attachment.filename}": ${err}`);
      if (settings.fallbackToDefault) {
        return defaultParser();
      }
      throw err;
    }
  }

  // ── External routing ──────────────────────────────────────────────────────

  private async routeExternal(
    ctx: Context,
    attachment: AttachmentLike,
    settings: Settings,
    defaultParser: DefaultParserFn,
  ): Promise<ParsedAttachmentResult> {
    if (!settings.activeProviderId) {
      ctx.log?.warn?.('[DocumentParser] mode=external but no activeProviderId configured');
      return settings.fallbackToDefault ? defaultParser() : this.unsupportedResult(attachment);
    }

    const providerRecord = await this.getProvidersRepo().findById(settings.activeProviderId);
    if (!providerRecord || !providerRecord.get('enabled')) {
      ctx.log?.warn?.(`[DocumentParser] External provider ${settings.activeProviderId} not found or disabled`);
      return settings.fallbackToDefault ? defaultParser() : this.unsupportedResult(attachment);
    }

    const providerConfig = this.recordToProviderConfig(providerRecord);

    // Check MIME type scope if the provider declares one
    const supportedMimetypes: string[] = providerConfig['supportedMimetypes'] ?? [];
    if (supportedMimetypes.length > 0 && attachment.mimetype && !supportedMimetypes.includes(attachment.mimetype)) {
      // This provider doesn't handle this MIME type — fall back
      return settings.fallbackToDefault ? defaultParser() : this.unsupportedResult(attachment);
    }

    try {
      const { buffer, url } = await this.getFileBuffer(ctx, attachment);

      const text = await callExternalOcr(providerConfig, {
        fileBuffer: buffer,
        filename: attachment.filename ?? attachment.name ?? 'file',
        mimetype: attachment.mimetype ?? 'application/octet-stream',
        fileUrl: url,
      });

      return textToContentBlock(text, attachment);
    } catch (err) {
      ctx.log?.warn?.(`[DocumentParser] external OCR failed for "${attachment.filename}": ${err}`);
      if (settings.fallbackToDefault) {
        return defaultParser();
      }
      throw err;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private recordToProviderConfig(record: any): OcrProviderConfig & { supportedMimetypes?: string[] } {
    return {
      apiEndpoint: record.get('apiEndpoint'),
      authType: record.get('authType'),
      apiKey: record.get('apiKey'),
      authConfig: record.get('authConfig') ?? {},
      requestFormat: record.get('requestFormat') ?? 'multipart',
      requestConfig: record.get('requestConfig') ?? {},
      responseTextPath: record.get('responseTextPath') ?? 'text',
      timeout: record.get('timeout') ?? 60000,
      supportedMimetypes: record.get('supportedMimetypes') ?? [],
    };
  }

  private unsupportedResult(attachment: AttachmentLike): ParsedAttachmentResult {
    return {
      placement: 'contentBlocks',
      content: {
        type: 'text',
        text: `[Attachment: ${attachment.filename ?? attachment.name ?? 'file'} — no parser available]`,
      },
    };
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

// resolveExtname is now imported from './utils'

/**
 * Build a content block that tells the LLM:
 *   "This document is indexed in DocPixie — do NOT try to read it inline,
 *    use the docpixie:query tool with the given documentId instead."
 *
 * The block intentionally omits full text content to avoid filling the
 * context window.  Instead it provides:
 *   - Document metadata (name, type, DocPixie ID)
 *   - Explicit instructions for tool usage
 *   - A ready-to-use query example
 */
function docpixieReferenceBlock(documentId: number, filename: string, mimetype: string): ParsedAttachmentResult {
  const safeFilename = sanitizeForXmlAttr(filename);
  const safeMimetype = sanitizeForXmlAttr(mimetype);
  const text = [
    `<document_indexed filename="${safeFilename}" type="${safeMimetype}" docpixie_id="${documentId}">`,
    `This document has been submitted to DocPixie for deep indexing (Document ID: ${documentId}).`,
    ``,
    `IMPORTANT: Do NOT attempt to read the raw file content inline.`,
    `Instead, use the \`docpixie:query\` tool to retrieve information from this document.`,
    ``,
    `Usage examples:`,
    `  - Summarize: docpixie:query { "query": "summarize this document", "documentIds": [${documentId}] }`,
    `  - Find info: docpixie:query { "query": "<user question>", "documentIds": [${documentId}] }`,
    ``,
    `Note: Indexing runs in the background. If you query immediately and get no results,`,
    `wait a moment and retry — complex documents (PDF with many pages) take longer to index.`,
    `</document_indexed>`,
  ].join('\n');

  return {
    placement: 'contentBlocks',
    content: { type: 'text', text },
  };
}

/** Wrap extracted text into the `ParsedAttachmentResult` shape that plugin-ai expects */
function textToContentBlock(text: string, attachment: AttachmentLike): ParsedAttachmentResult {
  const filename = sanitizeForXmlAttr(attachment.filename ?? attachment.name ?? 'document');
  const mimetype = sanitizeForXmlAttr(attachment.mimetype ?? '');
  return {
    placement: 'contentBlocks',
    content: {
      type: 'text',
      text: `<document filename="${filename}" type="${mimetype}">\n${text}\n</document>`,
    },
  };
}
