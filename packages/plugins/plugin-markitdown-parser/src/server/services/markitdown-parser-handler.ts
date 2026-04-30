import type { Context } from '@nocobase/actions';
import type { AttachmentLike, InternalParserHandler, InternalParseResult } from '../types';
import { MarkItDownService } from './markitdown-service';

export const MARKITDOWN_HANDLER_NAME = 'markitdown-parser';

export class MarkItDownParserHandler implements InternalParserHandler {
  readonly name = MARKITDOWN_HANDLER_NAME;

  constructor(
    private readonly service: MarkItDownService,
    private readonly getDocumentParserPlugin: () => any | null,
  ) {}

  supports(attachment: AttachmentLike): boolean {
    return this.service.supports(attachment);
  }

  async parse(attachment: AttachmentLike, ctx: Context): Promise<InternalParseResult> {
    const docParserPlugin = this.getDocumentParserPlugin();
    if (!docParserPlugin?.fetchFileBuffer) {
      ctx.log?.warn?.('[MarkItDownParser] plugin-document-parser fetchFileBuffer is not available');
      return { text: '', handled: false };
    }

    const { buffer } = await docParserPlugin.fetchFileBuffer(ctx, attachment);
    const text = await this.service.convertBuffer(buffer, attachment);
    return { text, handled: true };
  }
}
