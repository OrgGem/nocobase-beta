import type { Context } from '@nocobase/actions';
import type { AttachmentLike } from './internal-parser-registry';

export type DocumentParseUseCase = 'chat' | 'file-search' | 'api';
export type DocumentParseEngine =
  | 'pdf-inspector'
  | 'excel'
  | 'markitdown'
  | 'registered-handler'
  | 'external-ocr'
  | 'vision-ocr'
  | 'ai-loader';

export type DocumentParseAttempt = {
  engine: DocumentParseEngine;
  status: 'success' | 'skipped' | 'failed';
  reason?: string;
  durationMs: number;
};

export type DocumentParseResult = {
  handled: boolean;
  text: string;
  engine?: DocumentParseEngine;
  attempts: DocumentParseAttempt[];
};

export type DocumentParseOptions = {
  useCase?: DocumentParseUseCase;
  preferredEngine?: DocumentParseEngine;
  maxBytes?: number;
};

export type OcrEngineConfig =
  | { kind: 'none' }
  | { kind: 'external-provider'; providerId: string | number }
  | { kind: 'llm-vision'; serviceId: string; model: string }
  | { kind: 'provider-default' };

export type DocumentParserPipeline = {
  version: 1;
  pdf: {
    enabled: boolean;
    textThreshold: { minCharacters: number };
    maxBytes: number;
    maxPages: number;
  };
  ocr: {
    enabled: boolean;
    primary: OcrEngineConfig;
    fallback: OcrEngineConfig;
    timeoutMs: number;
  };
  chat: {
    fallbackToProviderDefault: boolean;
  };
};

export type OcrEngine = {
  readonly engine: Extract<DocumentParseEngine, 'external-ocr' | 'vision-ocr'>;
  parseBuffer(
    ctx: Context,
    buffer: Buffer,
    attachment: AttachmentLike,
    config: OcrEngineConfig,
    timeoutMs: number,
  ): Promise<string | null>;
};

export type DocumentParseDependencies = {
  getFileBuffer: (ctx: Context, attachment: AttachmentLike) => Promise<{ buffer: Buffer; url: string }>;
  getPipeline: () => Promise<DocumentParserPipeline>;
};
