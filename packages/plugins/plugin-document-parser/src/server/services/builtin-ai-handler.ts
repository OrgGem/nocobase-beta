/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';
import { loadByWorker } from '@nocobase/ai';
import type { AttachmentLike } from './internal-parser-registry';
import type { DocumentParseBufferHandler } from './document-parse-service';
import { resolveExtname } from './utils';

const AI_SUPPORTED_EXTNAMES = new Set(['.ppt', '.pptx', '.doc', '.docx', '.txt']);

export class BuiltinAIDocumentHandler implements DocumentParseBufferHandler {
  readonly engine = 'ai-loader' as const;

  supports(attachment: AttachmentLike): boolean {
    return AI_SUPPORTED_EXTNAMES.has(resolveExtname(attachment));
  }

  async parseBuffer(_ctx: Context, buffer: Buffer, attachment: AttachmentLike): Promise<string | null> {
    const extension = resolveExtname(attachment);
    const mimeType = attachment.mimetype || 'application/octet-stream';
    const blob = new Blob([buffer], { type: mimeType });
    const documents = await loadByWorker(extension, blob);
    const text = documents
      .map((document: { pageContent: string }) => document.pageContent)
      .join('\n\n')
      .trim();
    return text || null;
  }
}
