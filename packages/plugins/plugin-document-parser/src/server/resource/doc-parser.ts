import type { Context, Next } from '@nocobase/actions';
import type { AttachmentLike } from '../services/internal-parser-registry';
import type { DocumentParseService } from '../services/document-parse-service';
import type { MarkItDownService } from '../services/markitdown-service';
import type { PdfInspectorEngine } from '../services/pdf-inspector-engine';

const MAX_BASE64_BYTES = 50 * 1024 * 1024;

type DocumentParserDiagnostics = {
  documentParseService: DocumentParseService;
  markitdownService: MarkItDownService;
  pdfInspectorEngine: PdfInspectorEngine;
};

type ParseValues = {
  base64?: unknown;
  filename?: unknown;
  name?: unknown;
  mimetype?: unknown;
  extname?: unknown;
};

export function defineDocumentParserActions(diagnostics: DocumentParserDiagnostics) {
  return {
    async getRuntime(ctx: Context, next: Next) {
      ctx.body = {
        pdfInspector: await diagnostics.pdfInspectorEngine.checkAvailability(),
        markitdown: diagnostics.markitdownService.getRuntimeInfo(),
      };
      await next();
    },

    async checkEngine(ctx: Context, next: Next) {
      const engine = readEngine(ctx.action.params.values);
      if (engine === 'pdf-inspector') {
        ctx.body = await diagnostics.pdfInspectorEngine.checkAvailability();
      } else if (engine === 'markitdown') {
        ctx.body = await diagnostics.markitdownService.checkAvailability();
      } else {
        ctx.throw(400, 'Unknown document parser engine.');
        return;
      }
      await next();
    },

    async parse(ctx: Context, next: Next) {
      const values = readValues(ctx.action.params.values);
      if (typeof values.base64 !== 'string') {
        ctx.throw(400, 'A base64 attachment is required.');
        return;
      }

      const result = await diagnostics.documentParseService.parseBuffer(
        ctx,
        decodeBase64(values.base64),
        toAttachment(values),
        {
          useCase: 'api',
          maxBytes: MAX_BASE64_BYTES,
        },
      );
      ctx.body = result;
      await next();
    },
  };
}

function readEngine(value: unknown): 'pdf-inspector' | 'markitdown' | null {
  if (!isRecord(value)) return null;
  return value.engine === 'pdf-inspector' || value.engine === 'markitdown' ? value.engine : null;
}

function readValues(value: unknown): ParseValues {
  return isRecord(value) ? value : {};
}

function decodeBase64(value: string): Buffer {
  if (value.length > Math.ceil((MAX_BASE64_BYTES * 4) / 3) + 4) {
    throw new Error('The base64 attachment exceeds the 50 MiB limit.');
  }

  const normalized = value.replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) {
    throw new Error('Invalid base64 attachment.');
  }

  const buffer = Buffer.from(normalized, 'base64');
  if (buffer.length > MAX_BASE64_BYTES) {
    throw new Error('The base64 attachment exceeds the 50 MiB limit.');
  }
  return buffer;
}

function toAttachment(values: ParseValues): AttachmentLike {
  return {
    filename: asString(values.filename),
    name: asString(values.name),
    mimetype: asString(values.mimetype),
    extname: asString(values.extname),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
