import type { Context } from '@nocobase/actions';
import { DEFAULT_PIPELINE } from '../../shared/defaults';
import { DocumentParseService, type DocumentParseBufferHandler } from '../services/document-parse-service';
import type { DocumentParserPipeline, OcrEngine } from '../services/document-parse.types';
import { InternalParserRegistry, type AttachmentLike } from '../services/internal-parser-registry';

const context = {} as Context;
const pdf: AttachmentLike = { filename: 'report.pdf', mimetype: 'application/pdf' };
const image: AttachmentLike = { filename: 'receipt.png', mimetype: 'image/png' };

function pipeline(overrides: Partial<DocumentParserPipeline> = {}): DocumentParserPipeline {
  return {
    ...DEFAULT_PIPELINE,
    ...overrides,
    pdf: { ...DEFAULT_PIPELINE.pdf, ...overrides.pdf },
    ocr: { ...DEFAULT_PIPELINE.ocr, ...overrides.ocr },
    chat: { ...DEFAULT_PIPELINE.chat, ...overrides.chat },
  };
}

function handler(
  engine: DocumentParseBufferHandler['engine'],
  parseBuffer: DocumentParseBufferHandler['parseBuffer'],
  supports: (attachment: AttachmentLike) => boolean = () => true,
): DocumentParseBufferHandler {
  return { engine, parseBuffer, supports };
}

function service(
  handlers: DocumentParseBufferHandler[],
  configuredPipeline: DocumentParserPipeline = pipeline(),
  ocrEngines: OcrEngine[] = [],
) {
  return new DocumentParseService(
    {
      getFileBuffer: vi.fn(),
      getPipeline: vi.fn().mockResolvedValue(configuredPipeline),
    },
    new InternalParserRegistry(),
    handlers,
    ocrEngines,
  );
}

describe('DocumentParseService', () => {
  it('uses PDF Inspector before MarkItDown for usable PDF text', async () => {
    const pdfInspector = vi.fn().mockResolvedValue('# Native PDF text');
    const markitdown = vi.fn().mockResolvedValue('# MarkItDown text');
    const parser = service(
      [
        handler('pdf-inspector', pdfInspector, (attachment) => attachment.mimetype === 'application/pdf'),
        handler('markitdown', markitdown),
      ],
      pipeline({ pdf: { ...DEFAULT_PIPELINE.pdf, textThreshold: { minCharacters: 1 } } }),
    );

    const result = await parser.parseBuffer(context, Buffer.from('pdf'), pdf);

    expect(result).toMatchObject({ handled: true, engine: 'pdf-inspector', text: '# Native PDF text' });
    expect(markitdown).not.toHaveBeenCalled();
    expect(result.attempts).toEqual([expect.objectContaining({ engine: 'pdf-inspector', status: 'success' })]);
  });

  it('falls back from weak PDF Inspector text to configured external OCR', async () => {
    const externalOcr: OcrEngine = {
      engine: 'external-ocr',
      parseBuffer: vi.fn().mockResolvedValue('# OCR text'),
    };
    const parser = service(
      [handler('pdf-inspector', vi.fn().mockResolvedValue('short'), () => true)],
      pipeline({
        pdf: { ...DEFAULT_PIPELINE.pdf, textThreshold: { minCharacters: 10 } },
        ocr: {
          ...DEFAULT_PIPELINE.ocr,
          primary: { kind: 'external-provider', providerId: 1 },
        },
      }),
      [externalOcr],
    );

    const result = await parser.parseBuffer(context, Buffer.from('pdf'), pdf, { useCase: 'file-search' });

    expect(result).toMatchObject({ handled: true, engine: 'external-ocr', text: '# OCR text' });
    expect(externalOcr.parseBuffer).toHaveBeenCalledWith(
      context,
      Buffer.from('pdf'),
      pdf,
      { kind: 'external-provider', providerId: 1 },
      DEFAULT_PIPELINE.ocr.timeoutMs,
    );
    expect(result.attempts).toEqual([
      expect.objectContaining({ engine: 'pdf-inspector', status: 'skipped' }),
      expect.objectContaining({ engine: 'external-ocr', status: 'success' }),
    ]);
  });

  it('falls back from external OCR to Vision OCR when configured', async () => {
    const externalOcr: OcrEngine = {
      engine: 'external-ocr',
      parseBuffer: vi.fn().mockRejectedValue(new Error('Provider unavailable')),
    };
    const visionOcr: OcrEngine = {
      engine: 'vision-ocr',
      parseBuffer: vi.fn().mockResolvedValue('# Vision text'),
    };
    const parser = service(
      [],
      pipeline({
        ocr: {
          ...DEFAULT_PIPELINE.ocr,
          primary: { kind: 'external-provider', providerId: 'primary' },
          fallback: { kind: 'llm-vision', serviceId: 'vision-service', model: 'vision-model' },
        },
      }),
      [externalOcr, visionOcr],
    );

    const result = await parser.parseBuffer(context, Buffer.from('image'), image, { useCase: 'file-search' });

    expect(result).toMatchObject({ handled: true, engine: 'vision-ocr', text: '# Vision text' });
    expect(result.attempts).toEqual([
      expect.objectContaining({ engine: 'external-ocr', status: 'failed' }),
      expect.objectContaining({ engine: 'vision-ocr', status: 'success' }),
    ]);
  });

  it('does not use provider-default as an OCR fallback', async () => {
    const parser = service(
      [],
      pipeline({
        ocr: {
          ...DEFAULT_PIPELINE.ocr,
          primary: { kind: 'none' },
          fallback: { kind: 'provider-default' },
        },
      }),
    );

    const result = await parser.parseBuffer(context, Buffer.from('image'), image, { useCase: 'file-search' });

    expect(result).toEqual({ handled: false, text: '', attempts: [] });
  });

  it('does not run OCR for unsupported document types', async () => {
    const externalOcr: OcrEngine = {
      engine: 'external-ocr',
      parseBuffer: vi.fn().mockResolvedValue('# Unexpected OCR'),
    };
    const parser = service(
      [],
      pipeline({ ocr: { ...DEFAULT_PIPELINE.ocr, primary: { kind: 'external-provider', providerId: 1 } } }),
      [externalOcr],
    );

    const result = await parser.parseBuffer(context, Buffer.from('doc'), {
      filename: 'notes.docx',
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    expect(result).toEqual({ handled: false, text: '', attempts: [] });
    expect(externalOcr.parseBuffer).not.toHaveBeenCalled();
  });
});
