import type { Context } from '@nocobase/actions';
import type { AttachmentLike, InternalParserRegistry } from './internal-parser-registry';
import type {
  DocumentParseAttempt,
  DocumentParseDependencies,
  DocumentParseEngine,
  DocumentParseOptions,
  DocumentParseResult,
  DocumentParserPipeline,
  OcrEngine,
  OcrEngineConfig,
} from './document-parse.types';
import { resolveExtname } from './utils';

export type DocumentParseBufferHandler = {
  engine: DocumentParseEngine;
  supports(attachment: AttachmentLike): boolean;
  parseBuffer(ctx: Context, buffer: Buffer, attachment: AttachmentLike): Promise<string | null>;
};

export class DocumentParseService {
  private readonly ocrEngines: ReadonlyMap<OcrEngine['engine'], OcrEngine>;

  constructor(
    private readonly dependencies: DocumentParseDependencies,
    private readonly internalRegistry: InternalParserRegistry,
    private readonly handlers: DocumentParseBufferHandler[],
    ocrEngines: OcrEngine[] = [],
  ) {
    this.ocrEngines = new Map(ocrEngines.map((engine) => [engine.engine, engine]));
  }

  async parseAttachment(
    ctx: Context,
    attachment: AttachmentLike,
    options: DocumentParseOptions = {},
  ): Promise<DocumentParseResult> {
    const attempts: DocumentParseAttempt[] = [];
    const registeredResult = await this.parseRegisteredHandlers(ctx, attachment, attempts);
    if (registeredResult) {
      return registeredResult;
    }

    const { buffer } = await this.dependencies.getFileBuffer(ctx, attachment);
    return this.parseBufferWithAttempts(ctx, buffer, attachment, options, attempts);
  }

  async parseBuffer(
    ctx: Context,
    buffer: Buffer,
    attachment: AttachmentLike,
    options: DocumentParseOptions = {},
  ): Promise<DocumentParseResult> {
    return this.parseBufferWithAttempts(ctx, buffer, attachment, options, []);
  }

  private async parseBufferWithAttempts(
    ctx: Context,
    buffer: Buffer,
    attachment: AttachmentLike,
    options: DocumentParseOptions,
    attempts: DocumentParseAttempt[],
  ): Promise<DocumentParseResult> {
    if (options.maxBytes && buffer.length > options.maxBytes) {
      throw new Error(`Attachment exceeds the ${options.maxBytes} byte parser limit.`);
    }

    const pipeline = await this.dependencies.getPipeline();
    if (this.isPdf(attachment) && buffer.length > pipeline.pdf.maxBytes) {
      throw new Error(`PDF exceeds the ${pipeline.pdf.maxBytes} byte parser limit.`);
    }

    for (const handler of this.resolveHandlers(attachment, options.preferredEngine, pipeline)) {
      const startedAt = Date.now();
      try {
        const text = await handler.parseBuffer(ctx, buffer, attachment);
        const durationMs = Date.now() - startedAt;
        if (text?.trim() && this.isUsableText(handler.engine, text, attachment, pipeline)) {
          attempts.push({ engine: handler.engine, status: 'success', durationMs });
          return { handled: true, text, engine: handler.engine, attempts };
        }
        attempts.push({ engine: handler.engine, status: 'skipped', reason: 'No usable text extracted.', durationMs });
      } catch (error) {
        attempts.push({
          engine: handler.engine,
          status: 'failed',
          reason: getFailureReason(error),
          durationMs: Date.now() - startedAt,
        });
      }
    }

    return this.parseWithOcr(ctx, buffer, attachment, pipeline, attempts);
  }

  private async parseWithOcr(
    ctx: Context,
    buffer: Buffer,
    attachment: AttachmentLike,
    pipeline: DocumentParserPipeline,
    attempts: DocumentParseAttempt[],
  ): Promise<DocumentParseResult> {
    if (!pipeline.ocr.enabled || !this.isOcrCandidate(attachment)) {
      return { handled: false, text: '', attempts };
    }

    for (const config of [pipeline.ocr.primary, pipeline.ocr.fallback]) {
      const result = await this.runOcrEngine(ctx, buffer, attachment, config, pipeline.ocr.timeoutMs, attempts);
      if (result) {
        return { handled: true, text: result.text, engine: result.engine, attempts };
      }
    }

    return { handled: false, text: '', attempts };
  }

  private async runOcrEngine(
    ctx: Context,
    buffer: Buffer,
    attachment: AttachmentLike,
    config: OcrEngineConfig,
    timeoutMs: number,
    attempts: DocumentParseAttempt[],
  ): Promise<{ engine: Extract<DocumentParseEngine, 'external-ocr' | 'vision-ocr'>; text: string } | null> {
    const engineName =
      config.kind === 'external-provider' ? 'external-ocr' : config.kind === 'llm-vision' ? 'vision-ocr' : null;
    if (!engineName) {
      return null;
    }

    const engine = this.ocrEngines.get(engineName);
    if (!engine) {
      attempts.push({ engine: engineName, status: 'skipped', reason: 'OCR engine is unavailable.', durationMs: 0 });
      return null;
    }

    const startedAt = Date.now();
    try {
      const text = await engine.parseBuffer(ctx, buffer, attachment, config, timeoutMs);
      const durationMs = Date.now() - startedAt;
      if (text?.trim()) {
        attempts.push({ engine: engineName, status: 'success', durationMs });
        return { engine: engineName, text };
      }
      attempts.push({ engine: engineName, status: 'skipped', reason: 'No text extracted.', durationMs });
    } catch (error) {
      attempts.push({
        engine: engineName,
        status: 'failed',
        reason: getFailureReason(error),
        durationMs: Date.now() - startedAt,
      });
    }

    return null;
  }

  private resolveHandlers(
    attachment: AttachmentLike,
    preferredEngine: DocumentParseEngine | undefined,
    pipeline: DocumentParserPipeline,
  ): DocumentParseBufferHandler[] {
    const supported = this.handlers.filter(
      (handler) => handler.supports(attachment) && (pipeline.pdf.enabled || handler.engine !== 'pdf-inspector'),
    );
    if (!preferredEngine) return supported;

    const preferred = supported.filter((handler) => handler.engine === preferredEngine);
    const remaining = supported.filter((handler) => handler.engine !== preferredEngine);
    return [...preferred, ...remaining];
  }

  private isUsableText(
    engine: DocumentParseEngine,
    text: string,
    attachment: AttachmentLike,
    pipeline: DocumentParserPipeline,
  ): boolean {
    return (
      engine !== 'pdf-inspector' ||
      !this.isPdf(attachment) ||
      text.trim().length >= pipeline.pdf.textThreshold.minCharacters
    );
  }

  private isOcrCandidate(attachment: AttachmentLike): boolean {
    return this.isPdf(attachment) || attachment.mimetype?.startsWith('image/') === true;
  }

  private isPdf(attachment: AttachmentLike): boolean {
    return attachment.mimetype === 'application/pdf' || resolveExtname(attachment) === '.pdf';
  }

  private async parseRegisteredHandlers(
    ctx: Context,
    attachment: AttachmentLike,
    attempts: DocumentParseAttempt[],
  ): Promise<DocumentParseResult | null> {
    if (this.internalRegistry.size === 0) {
      return null;
    }

    const startedAt = Date.now();
    try {
      const result = await this.internalRegistry.parse(attachment, ctx);
      const durationMs = Date.now() - startedAt;
      if (result.handled && result.text.trim()) {
        attempts.push({ engine: 'registered-handler', status: 'success', durationMs });
        return { handled: true, text: result.text, engine: 'registered-handler', attempts };
      }
      attempts.push({
        engine: 'registered-handler',
        status: 'skipped',
        reason: 'No handler extracted text.',
        durationMs,
      });
    } catch (error) {
      attempts.push({
        engine: 'registered-handler',
        status: 'failed',
        reason: getFailureReason(error),
        durationMs: Date.now() - startedAt,
      });
    }

    return null;
  }
}

function getFailureReason(error: unknown): string {
  return error instanceof Error && error.name ? `${error.name} failed.` : 'Parser failed.';
}
