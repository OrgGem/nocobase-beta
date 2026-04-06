/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export { default } from './plugin';
export { PluginDocumentParserServer } from './plugin';
export { InternalParserRegistry } from './services/internal-parser-registry';
export type { InternalParserHandler, InternalParseResult, AttachmentLike } from './services/internal-parser-registry';
export type { OcrProviderConfig, OcrAuthType, OcrRequestFormat } from './services/external-ocr-client';
export type { ParsedAttachmentResult } from './services/parse-router';
export { resolveExtname, sanitizeForXmlAttr } from './services/utils';
