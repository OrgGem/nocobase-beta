import type { Context } from '@nocobase/actions';
import { describe, expect, it, vi } from 'vitest';
import { PluginFilePreviewAuthServer } from '../plugin';

type DocumentParseServiceStub = {
  parseBuffer: ReturnType<typeof vi.fn>;
  parseAttachment: ReturnType<typeof vi.fn>;
};

type TestPlugin = PluginFilePreviewAuthServer & {
  getDocumentParseService(): DocumentParseServiceStub | null;
  extractUploadedFileText(ctx: Context, buffer: Buffer, attachment: Record<string, unknown>): Promise<string>;
  extractAttachmentText(ctx: Context, attachment: Record<string, unknown>): Promise<string>;
  readAttachmentAsText(attachment: Record<string, unknown>): Promise<string>;
  pm: { get: ReturnType<typeof vi.fn> };
  app: { pm: { get: ReturnType<typeof vi.fn> }; log: { warn: ReturnType<typeof vi.fn> } };
};

function createPlugin(service: DocumentParseServiceStub | null): TestPlugin {
  const plugin = Object.create(PluginFilePreviewAuthServer.prototype) as TestPlugin;
  Object.assign(plugin, {
    getDocumentParseService: () => service,
    app: { pm: { get: vi.fn() }, log: { warn: vi.fn() } },
  });
  return plugin;
}

describe('Document Parser extraction', () => {
  it('parses raw uploads through Document Parser', async () => {
    const service = {
      parseBuffer: vi.fn().mockResolvedValue({ handled: true, text: '# Parsed DOCX', attempts: [] }),
      parseAttachment: vi.fn(),
    };
    const plugin = createPlugin(service);
    const ctx = {} as Context;
    const attachment = {
      filename: 'guide.docx',
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    const buffer = Buffer.from('docx');

    await expect(plugin.extractUploadedFileText(ctx, buffer, attachment)).resolves.toBe('# Parsed DOCX');
    expect(service.parseBuffer).toHaveBeenCalledWith(ctx, buffer, attachment, { useCase: 'api' });
    expect(service.parseAttachment).not.toHaveBeenCalled();
  });

  it('parses persisted attachments through Document Parser', async () => {
    const service = {
      parseBuffer: vi.fn(),
      parseAttachment: vi.fn().mockResolvedValue({ handled: true, text: '# Parsed PDF', attempts: [] }),
    };
    const plugin = createPlugin(service);
    const ctx = {} as Context;
    const attachment = { id: 1, filename: 'guide.pdf', mimetype: 'application/pdf' };

    await expect(plugin.extractAttachmentText(ctx, attachment)).resolves.toBe('# Parsed PDF');
    expect(service.parseAttachment).toHaveBeenCalledWith(ctx, attachment, { useCase: 'api' });
    expect(service.parseBuffer).not.toHaveBeenCalled();
  });

  it('falls back only for recognized plain-text attachments', async () => {
    const service = {
      parseBuffer: vi.fn().mockResolvedValue({ handled: false, text: '', attempts: [] }),
      parseAttachment: vi.fn().mockResolvedValue({ handled: false, text: '', attempts: [] }),
    };
    const plugin = createPlugin(service);
    const ctx = {} as Context;
    const textAttachment = { filename: 'notes.txt', extname: '.txt', mimetype: 'text/plain' };
    const binaryAttachment = {
      filename: 'guide.docx',
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    plugin.readAttachmentAsText = vi.fn().mockResolvedValue('saved text');

    await expect(plugin.extractUploadedFileText(ctx, Buffer.from('raw text'), textAttachment)).resolves.toBe(
      'raw text',
    );
    await expect(plugin.extractAttachmentText(ctx, textAttachment)).resolves.toBe('saved text');
    await expect(plugin.extractUploadedFileText(ctx, Buffer.from('binary'), binaryAttachment)).resolves.toBe('');
    await expect(plugin.extractAttachmentText(ctx, binaryAttachment)).resolves.toBe('');
    expect(plugin.readAttachmentAsText).toHaveBeenCalledWith(textAttachment);
    expect(plugin.readAttachmentAsText).not.toHaveBeenCalledWith(binaryAttachment);
  });

  it('looks up only canonical Document Parser plugin names', () => {
    const plugin = Object.create(PluginFilePreviewAuthServer.prototype) as TestPlugin;
    const pm = {
      get: vi.fn((name: string) => (name === 'plugin-document-parser' ? { documentParseService: {} } : null)),
    };
    Object.assign(plugin, { app: { pm, log: { warn: vi.fn() } } });

    plugin.getDocumentParseService();

    expect(pm.get).toHaveBeenCalledWith('plugin-document-parser');
    expect(pm.get).not.toHaveBeenCalledWith('@nocobase/plugin-document-parser');
  });
});
