import type { Context } from '@nocobase/actions';
import type { AttachmentLike } from './types';

export const defineActions = (plugin: any) => {
  return {
    async getRuntime(ctx: Context, next: () => Promise<any>) {
      ctx.body = plugin.service.getRuntimeInfo();
      await next();
    },

    async check(ctx: Context, next: () => Promise<any>) {
      ctx.body = await plugin.service.checkAvailability();
      await next();
    },

    async parse(ctx: Context, next: () => Promise<any>) {
      const { values } = ctx.action.params;
      const text = await parseValues(plugin, ctx, values || {});
      ctx.body = { text };
      await next();
    },
  };
};

async function parseValues(plugin: any, ctx: Context, values: any): Promise<string> {
  if (values.base64) {
    const attachment: AttachmentLike = {
      filename: values.filename,
      name: values.name,
      mimetype: values.mimetype,
      extname: values.extname,
    };
    return plugin.service.convertBuffer(Buffer.from(values.base64, 'base64'), attachment);
  }

  if (values.attachment) {
    const docParserPlugin = plugin.getDocumentParserPlugin?.();
    if (!docParserPlugin?.fetchFileBuffer) {
      throw new Error('plugin-document-parser is required to parse an attachment object.');
    }
    const { buffer } = await docParserPlugin.fetchFileBuffer(ctx, values.attachment);
    return plugin.service.convertBuffer(buffer, values.attachment);
  }

  throw new Error('Provide either values.base64 or values.attachment.');
}
