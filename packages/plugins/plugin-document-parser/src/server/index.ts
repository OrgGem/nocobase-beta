// SPDX-License-Identifier: Apache-2.0

export { default } from './plugin';
export { PluginDocumentParserServer } from './plugin';
export { InternalParserRegistry } from './services/internal-parser-registry';
export { DocumentParseService } from './services/document-parse-service';
export { MarkItDownService } from './services/markitdown-service';
export type { AttachmentLike, InternalParserHandler, InternalParseResult } from './services/internal-parser-registry';
export type {
  DocumentParseAttempt,
  DocumentParseEngine,
  DocumentParseOptions,
  DocumentParseResult,
  DocumentParserPipeline,
  OcrEngineConfig,
} from './services/document-parse.types';
export type { OcrProviderConfig, OcrAuthType, OcrRequestFormat } from './services/external-ocr-client';
export type { ParsedAttachmentResult } from './services/parse-router';
export { resolveExtname, sanitizeForXmlAttr } from './services/utils';
