import { Application } from '@nocobase/server';
import { COLLECTION, DEFAULTS, SUPPORTED_OUTPUT_FORMATS, CarboneOutputFormat } from '../../shared/constants';
import { CarboneClient } from './carbone-client';
import { CacheManager, buildCacheKey, inputMd5 } from './cache-manager';
import { writeBufferAsAttachment } from './attachment-helper';

export interface RenderInput {
  templateId?: number;
  versionId?: number;
  carboneTemplateId: string; // resolved upstream
  data: unknown;
  format?: CarboneOutputFormat;
  filename?: string;
  bypassCache?: boolean;
  persistOutput?: boolean; // when false the buffer is returned but no attachment is created
}

export interface RenderOutcome {
  attachmentId: number | null;
  url: string | null;
  buffer: Buffer | null;
  format: CarboneOutputFormat;
  size: number;
  cacheHit: boolean;
  cacheKey: string;
  inputMd5: string;
  durationMs: number;
}

/**
 * Orchestrates render = cache lookup → Carbone API → file-manager save → cache write.
 *
 * Stateless apart from the helpers it composes. All policy decisions
 * (whether to persist output, whether to bypass cache, which storage to use)
 * are passed in via `RenderInput` or read from the singleton settings row.
 */
export class RenderPipeline {
  constructor(
    private readonly app: Application,
    private readonly carbone: CarboneClient,
    private readonly cache: CacheManager,
  ) {}

  async render(input: RenderInput): Promise<RenderOutcome> {
    const settings = await this.loadSettings();
    const format = (input.format ?? settings.defaultOutputFormat ?? 'pdf') as CarboneOutputFormat;
    if (!SUPPORTED_OUTPUT_FORMATS.includes(format)) {
      throw new Error(`Unsupported output format: ${format}`);
    }

    const cacheKey = buildCacheKey(input.carboneTemplateId, input.data, format);
    const useCache = settings.enableCache && !input.bypassCache && input.persistOutput !== false;

    const t0 = Date.now();

    if (useCache) {
      const hit = await this.cache.lookup(cacheKey);
      if (hit.status === 'hit') {
        return {
          attachmentId: hit.attachmentId,
          url: hit.url,
          buffer: null,
          format,
          size: hit.sizeBytes,
          cacheHit: true,
          cacheKey,
          inputMd5: inputMd5(input.data),
          durationMs: Date.now() - t0,
        };
      }
    }

    // Cache miss → call Carbone.
    const result = await this.carbone.render(input.carboneTemplateId, {
      data: input.data,
      convertTo: format,
      reportName: input.filename,
    });

    let attachmentId: number | null = null;
    let url: string | null = null;

    if (input.persistOutput !== false) {
      const filename =
        input.filename || `${input.carboneTemplateId.slice(0, 8)}-${Date.now()}.${format}`;
      const attachment = await writeBufferAsAttachment(this.app, result.buffer, {
        filename,
        storageId: settings.outputStorageId,
      });
      attachmentId = attachment.id;
      url = attachment.url;

      if (useCache) {
        // The output may live on a different storage than the cache wants —
        // re-store on the cache storage when set, otherwise reuse the same
        // attachment (saves disk).
        let cacheAttachmentId = attachmentId;
        let cacheSize = result.buffer.length;
        if (
          settings.cacheStorageId &&
          settings.cacheStorageId !== settings.outputStorageId
        ) {
          const cacheAttachment = await writeBufferAsAttachment(this.app, result.buffer, {
            filename,
            storageId: settings.cacheStorageId,
          });
          cacheAttachmentId = cacheAttachment.id;
          cacheSize = cacheAttachment.size ?? cacheSize;
        }
        await this.cache.store({
          cacheKey,
          templateId: input.templateId,
          versionId: input.versionId,
          carboneTemplateId: input.carboneTemplateId,
          format,
          inputMd5: inputMd5(input.data),
          outputAttachmentId: cacheAttachmentId!,
          sizeBytes: cacheSize,
          ttlSeconds: settings.cacheTTL ?? DEFAULTS.cacheTTL,
        });
      }
    }

    return {
      attachmentId,
      url,
      buffer: input.persistOutput === false ? result.buffer : null,
      format,
      size: result.buffer.length,
      cacheHit: false,
      cacheKey,
      inputMd5: inputMd5(input.data),
      durationMs: Date.now() - t0,
    };
  }

  private async loadSettings() {
    const row = await this.app.db.getRepository(COLLECTION.settings).findOne({});
    return row?.toJSON() ?? { ...DEFAULTS };
  }
}
