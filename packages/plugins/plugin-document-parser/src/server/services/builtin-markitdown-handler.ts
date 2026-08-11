import type { Context } from '@nocobase/actions';
import type { AttachmentLike } from './internal-parser-registry';
import type { DocumentParseBufferHandler } from './document-parse-service';
import { MarkItDownService } from './markitdown-service';

export class BuiltinMarkitdownHandler implements DocumentParseBufferHandler {
  readonly engine = 'markitdown' as const;

  constructor(private readonly service: MarkItDownService) {}

  supports(attachment: AttachmentLike): boolean {
    return this.service.supports(attachment);
  }

  async parseBuffer(_ctx: Context, buffer: Buffer, attachment: AttachmentLike): Promise<string | null> {
    const text = await this.service.parseBuffer(buffer, attachment);
    return text.trim() || null;
  }
}
