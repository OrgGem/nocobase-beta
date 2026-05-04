/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import type { InternalParserHandler, InternalParseResult, AttachmentLike } from './internal-parser-registry';
import { resolveExtname } from './utils';

// Extnames that plugin-ai's CachedDocumentLoader natively handles
const AI_SUPPORTED_EXTNAMES = new Set(['.pdf', '.ppt', '.pptx', '.doc', '.docx', '.txt']);

/**
 * Built-in internal parser handler that delegates to plugin-ai's
 * `DocumentLoaders.cached` — the same infrastructure used by the
 * Knowledge Base feature.
 *
 * This handler is registered automatically during plugin load with the
 * lowest priority (appended last) so custom handlers from other plugins
 * can take precedence.
 */
import { loadByWorker } from '@nocobase/ai';

export class BuiltinAIDocumentHandler implements InternalParserHandler {
  readonly name = 'builtin-ai-document-loader';

  constructor(
    private readonly fetchFileBuffer: (
      ctx: Context,
      attachment: AttachmentLike,
    ) => Promise<{ buffer: Buffer; url: string }>,
  ) {}

  supports(attachment: AttachmentLike): boolean {
    const ext = resolveExtname(attachment);
    return AI_SUPPORTED_EXTNAMES.has(ext);
  }

  async parse(attachment: AttachmentLike, ctx: Context): Promise<InternalParseResult> {
    try {
      const { buffer } = await this.fetchFileBuffer(ctx, attachment);
      const ext = resolveExtname(attachment);
      const mimeType = attachment.mimetype || 'application/octet-stream';
      const blob = new Blob([buffer], { type: mimeType });
      
      const documents = await loadByWorker(ext, blob);
      const text = documents.map((doc: any) => doc.pageContent).join('\n\n');

      return {
        text: text ?? '',
        handled: true,
      };
    } catch (err: any) {
      ctx.log?.error?.('[BuiltinAIDocumentHandler] loadByWorker parsing failed', err);
      return { text: '', handled: false };
    }
  }
}
