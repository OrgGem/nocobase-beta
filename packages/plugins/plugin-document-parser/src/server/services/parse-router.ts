import { Context } from '@nocobase/actions';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, unlink } from 'fs/promises';
import type { Repository } from '@nocobase/database';
import type { AttachmentLike } from './internal-parser-registry';
import type { DocumentParseService } from './document-parse-service';
import { resolveExtname, sanitizeForXmlAttr } from './utils';
import { DEFAULT_SETTINGS, resolvePipeline } from '../../shared/defaults';
import type { DocumentParserPipeline } from './document-parse.types';

export type ParsedAttachmentResult = {
  placement: string;
  content: unknown;
};

export type DefaultParserFn = () => Promise<ParsedAttachmentResult>;

type Settings = {
  imagePassThrough: boolean;
  includedExtnames: string[];
  useDocpixie: boolean;
  pipeline: DocumentParserPipeline;
};

type DocpixieService = {
  isReady(): boolean;
  processDocument(path: string, options: { name: string }): Promise<number>;
};

type DocpixiePlugin = {
  service?: DocpixieService;
};

export class ParseRouter {
  constructor(
    private readonly getSettingsRepo: () => Repository,
    private readonly documentParseService: DocumentParseService,
    private readonly getFileBuffer: (
      ctx: Context,
      attachment: AttachmentLike,
    ) => Promise<{ buffer: Buffer; url: string }>,
    private readonly getDocpixiePlugin: () => DocpixiePlugin | null = () => null,
  ) {}

  private cachedSettings: Settings | null = null;
  private settingsCachedAt = 0;
  private readonly cacheTtlMs = 5_000;

  private async getSettings(): Promise<Settings> {
    const now = Date.now();
    if (this.cachedSettings && now - this.settingsCachedAt < this.cacheTtlMs) {
      return this.cachedSettings;
    }

    const repo = this.getSettingsRepo();
    let record = await repo.findOne({});
    if (!record) {
      record = await repo.create({ values: { ...DEFAULT_SETTINGS } });
    }

    this.cachedSettings = {
      imagePassThrough: record.get('imagePassThrough') ?? true,
      includedExtnames: Array.isArray(record.get('includedExtnames')) ? record.get('includedExtnames') : [],
      useDocpixie: record.get('useDocpixie') ?? false,
      pipeline: resolvePipeline(record.get('pipeline'), {
        activeProviderId: record.get('activeProviderId'),
        fallbackToDefault: record.get('fallbackToDefault'),
      }),
    };
    this.settingsCachedAt = now;
    return this.cachedSettings;
  }

  invalidateSettingsCache(): void {
    this.cachedSettings = null;
  }

  async route(
    ctx: Context,
    attachment: AttachmentLike,
    defaultParser: DefaultParserFn,
  ): Promise<ParsedAttachmentResult> {
    const settings = await this.getSettings();

    if (settings.imagePassThrough && attachment.mimetype?.startsWith('image/')) {
      return defaultParser();
    }

    if (settings.includedExtnames.length > 0 && !settings.includedExtnames.includes(resolveExtname(attachment))) {
      return defaultParser();
    }

    if (settings.useDocpixie) {
      const docpixieResult = await this.routeDocpixie(ctx, attachment);
      if (docpixieResult) {
        return docpixieResult;
      }
    }

    const result = await this.documentParseService.parseAttachment(ctx, attachment, { useCase: 'chat' });
    if (result.handled) {
      return textToContentBlock(result.text, attachment);
    }

    if (settings.pipeline.chat.fallbackToProviderDefault) {
      return defaultParser();
    }
    return unsupportedResult(attachment);
  }

  private async routeDocpixie(ctx: Context, attachment: AttachmentLike): Promise<ParsedAttachmentResult | null> {
    const service = this.getDocpixiePlugin()?.service;
    if (!service?.isReady()) {
      return null;
    }

    const filename = attachment.filename ?? attachment.name ?? 'document';
    const mimetype = attachment.mimetype ?? 'application/octet-stream';
    let tempPath: string | null = null;

    try {
      const { buffer } = await this.getFileBuffer(ctx, attachment);
      tempPath = join(
        tmpdir(),
        `docparser-${Date.now()}-${Math.random().toString(36).slice(2)}${resolveExtname(attachment) || '.bin'}`,
      );
      await writeFile(tempPath, buffer);
      const documentId = await service.processDocument(tempPath, { name: filename });
      return docpixieReferenceBlock(documentId, filename, mimetype);
    } catch (error) {
      ctx.log?.warn?.(`[DocumentParser] DocPixie indexing failed for ${filename}: ${getErrorName(error)}`);
      return null;
    } finally {
      if (tempPath) {
        await unlink(tempPath).catch(() => undefined);
      }
    }
  }
}

function unsupportedResult(attachment: AttachmentLike): ParsedAttachmentResult {
  return {
    placement: 'contentBlocks',
    content: {
      type: 'text',
      text: `[Attachment: ${attachment.filename ?? attachment.name ?? 'file'} — no parser available]`,
    },
  };
}

function docpixieReferenceBlock(documentId: number, filename: string, mimetype: string): ParsedAttachmentResult {
  const safeFilename = sanitizeForXmlAttr(filename);
  const safeMimetype = sanitizeForXmlAttr(mimetype);
  const text = [
    `<document_indexed filename="${safeFilename}" type="${safeMimetype}" docpixie_id="${documentId}">`,
    `This document has been submitted to DocPixie for deep indexing (Document ID: ${documentId}).`,
    '',
    'IMPORTANT: Do NOT attempt to read the raw file content inline.',
    'Instead, use the `docpixie:query` tool to retrieve information from this document.',
    '',
    '</document_indexed>',
  ].join('\n');

  return { placement: 'contentBlocks', content: { type: 'text', text } };
}

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

function getErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}
