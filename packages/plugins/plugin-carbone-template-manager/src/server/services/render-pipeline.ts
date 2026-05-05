import { Application } from '@nocobase/server';
import { COLLECTION, DEFAULTS, SUPPORTED_OUTPUT_FORMATS, CarboneOutputFormat } from '../../shared/constants';
import { CarboneClient } from './carbone-client';
import { CacheManager, buildCacheKey, inputMd5 } from './cache-manager';
import { readAttachmentBuffer, writeBufferAsAttachment } from './attachment-helper';

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
    // Cache LOOKUP runs whenever caching is on and the caller didn't bypass —
    // independent of `persistOutput`, so inline previews (playground) can hit
    // entries populated by earlier persisted renders.
    const useCache = settings.enableCache && !input.bypassCache;
    const persistOutput = input.persistOutput !== false;

    const t0 = Date.now();

    if (useCache) {
      const hit = await this.cache.lookup(cacheKey);
      if (hit.status === 'hit') {
        // Inline callers need the buffer back; read it from the cache
        // attachment. If that read fails (file vanished mid-flight) fall
        // through to a fresh render rather than returning empty bytes.
        let buffer: Buffer | null = null;
        let bufferOk = persistOutput;
        if (!persistOutput) {
          try {
            buffer = (await readAttachmentBuffer(this.app, hit.attachmentId)).buffer;
            bufferOk = true;
          } catch (err) {
            this.app.logger?.warn(
              `[carbone] cache hit but attachment unreadable, re-rendering: ${err}`,
            );
          }
        }
        if (bufferOk) {
          return {
            attachmentId: persistOutput ? hit.attachmentId : null,
            url: persistOutput ? hit.url : null,
            buffer,
            format,
            size: hit.sizeBytes,
            cacheHit: true,
            cacheKey,
            inputMd5: inputMd5(input.data),
            durationMs: Date.now() - t0,
          };
        }
      }
    }

    // Cache miss → call Carbone.
    const result = await this.carbone.render(input.carboneTemplateId, {
      data: input.data,
      convertTo: format,
      reportName: input.filename,
    });
    const filename =
      input.filename || `${input.carboneTemplateId.slice(0, 8)}-${Date.now()}.${format}`;

    let attachmentId: number | null = null;
    let url: string | null = null;
    if (persistOutput) {
      const attachment = await writeBufferAsAttachment(this.app, result.buffer, {
        filename,
        storageId: settings.outputStorageId,
      });
      attachmentId = attachment.id;
      url = attachment.url;
    }

    if (useCache) {
      // Cache attachment: reuse the output one when storages match (saves
      // disk); otherwise write a dedicated cache attachment. When the caller
      // didn't persist, we always need a fresh attachment for the cache row.
      let cacheAttachmentId: number;
      let cacheSize: number;
      const cacheStorageDiffers =
        settings.cacheStorageId && settings.cacheStorageId !== settings.outputStorageId;
      if (attachmentId !== null && !cacheStorageDiffers) {
        cacheAttachmentId = attachmentId;
        cacheSize = result.buffer.length;
      } else {
        const cacheAttachment = await writeBufferAsAttachment(this.app, result.buffer, {
          filename,
          storageId: settings.cacheStorageId ?? settings.outputStorageId,
        });
        cacheAttachmentId = cacheAttachment.id;
        cacheSize = cacheAttachment.size ?? result.buffer.length;
      }
      await this.cache.store({
        cacheKey,
        templateId: input.templateId,
        versionId: input.versionId,
        carboneTemplateId: input.carboneTemplateId,
        format,
        inputMd5: inputMd5(input.data),
        outputAttachmentId: cacheAttachmentId,
        sizeBytes: cacheSize,
        ttlSeconds: settings.cacheTTL ?? DEFAULTS.cacheTTL,
        cacheMaxSize: settings.cacheMaxSize ?? DEFAULTS.cacheMaxSize,
      });
    }

    return {
      attachmentId,
      url,
      buffer: persistOutput ? null : result.buffer,
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
