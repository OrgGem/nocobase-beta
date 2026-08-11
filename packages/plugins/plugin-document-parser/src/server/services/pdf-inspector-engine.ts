import type { Context } from '@nocobase/actions';
import type { AttachmentLike } from './internal-parser-registry';
import type { DocumentParseBufferHandler } from './document-parse-service';
import { resolveExtname } from './utils';

export type PdfInspectorRuntimeInfo = {
  engine: 'pdf-inspector';
  available: boolean;
  message: string;
};

type PdfInspectorResult = {
  pdfType: 'TextBased' | 'Scanned' | 'ImageBased' | 'Mixed';
  markdown?: string;
  pagesNeedingOcr: number[];
};

type PdfInspectorModule = {
  processPdf(buffer: Buffer): PdfInspectorResult;
};

export class PdfInspectorEngine implements DocumentParseBufferHandler {
  readonly engine = 'pdf-inspector' as const;

  supports(attachment: AttachmentLike): boolean {
    return attachment.mimetype === 'application/pdf' || resolveExtname(attachment) === '.pdf';
  }

  async checkAvailability(): Promise<PdfInspectorRuntimeInfo> {
    try {
      this.loadModule();
      return { engine: 'pdf-inspector', available: true, message: 'PDF Inspector is available.' };
    } catch (error) {
      return {
        engine: 'pdf-inspector',
        available: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async parseBuffer(_ctx: Context, buffer: Buffer, attachment: AttachmentLike): Promise<string | null> {
    const startedAt = Date.now();
    try {
      const result = this.loadModule().processPdf(buffer);
      const markdown = result.markdown?.trim() ?? '';
      const needsOcr =
        result.pdfType === 'Scanned' || result.pdfType === 'ImageBased' || result.pagesNeedingOcr.length > 0;
      if (needsOcr || !markdown) {
        return null;
      }
      return markdown;
    } finally {
      _ctx.log?.debug?.(
        `[DocumentParser] PDF Inspector attachment=${String(attachment.id ?? attachment.filename ?? 'unknown')} bytes=${
          buffer.length
        } durationMs=${Date.now() - startedAt}`,
      );
    }
  }

  private loadModule(): PdfInspectorModule {
    try {
      const loaded: unknown = require('@firecrawl/pdf-inspector');
      if (!isPdfInspectorModule(loaded)) {
        throw new Error('PDF Inspector does not export processPdf(buffer).');
      }
      return loaded;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`PDF Inspector is unavailable: ${message}`);
    }
  }
}

function isPdfInspectorModule(value: unknown): value is PdfInspectorModule {
  return (
    typeof value === 'object' && value !== null && typeof (value as { processPdf?: unknown }).processPdf === 'function'
  );
}
