import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import type { Context } from '@nocobase/actions';
import type { AttachmentLike, ExtractedDocument, FileSearchSettings } from '../types';
import { getDisplayFilename, isDirectPageIndexFile, resolveExtname, sha256 } from './file-utils';

export class DocumentTextExtractor {
  constructor(private readonly app: any) {}

  async extract(ctx: Context, attachment: AttachmentLike, settings: FileSearchSettings): Promise<ExtractedDocument> {
    const docParser = this.getDocumentParser();
    if (!docParser?.fetchFileBuffer) {
      throw new Error('plugin-document-parser is required to fetch file buffers.');
    }

    const { buffer } = await docParser.fetchFileBuffer(ctx, attachment);
    const checksum = sha256(buffer);
    const extname = resolveExtname(attachment);
    const sizeMb = buffer.length / 1024 / 1024;
    if (sizeMb > settings.maxFileSizeMb) {
      throw new Error(`File exceeds max size ${settings.maxFileSizeMb} MB.`);
    }
    if (settings.allowedExtnames.length && !settings.allowedExtnames.includes(extname)) {
      throw new Error(`File extension "${extname}" is not enabled for indexing.`);
    }

    if (isDirectPageIndexFile(extname) || settings.parserStrategy === 'direct') {
      const directExt = extname || '.bin';
      const filePath = await this.writeTempFile(buffer, directExt);
      return {
        filePath,
        cleanup: () => fsp.unlink(filePath).catch(() => undefined),
        checksum,
        mode: extname === '.pdf' ? 'pdf' : 'md',
      };
    }

    const text = await this.parseToText(ctx, attachment, settings);
    if (!text.trim()) {
      throw new Error(`No text could be extracted from ${getDisplayFilename(attachment)}.`);
    }
    const filePath = await this.writeTempFile(Buffer.from(text, 'utf8'), '.md');
    return {
      filePath,
      cleanup: () => fsp.unlink(filePath).catch(() => undefined),
      checksum,
      mode: 'md',
    };
  }

  private async parseToText(ctx: Context, attachment: AttachmentLike, settings: FileSearchSettings) {
    const docParser = this.getDocumentParser();
    const markitdown = this.getMarkItDown();

    if (settings.parserStrategy === 'markitdown' && markitdown?.service?.parseAttachment) {
      return markitdown.service.parseAttachment(ctx, attachment);
    }

    if (docParser?.parseAttachmentToText) {
      const text = await docParser.parseAttachmentToText(ctx, attachment);
      if (text) return text;
    }

    if (markitdown?.service?.parseAttachment) {
      return markitdown.service.parseAttachment(ctx, attachment);
    }

    const result = await docParser?.internalParserRegistry?.parse?.(attachment, ctx);
    return result?.handled ? result.text || '' : '';
  }

  private getDocumentParser() {
    return (
      this.app.pm?.get?.('@nocobase/plugin-document-parser') ||
      this.app.pm?.get?.('plugin-document-parser') ||
      this.app.pm?.get?.('document-parser')
    );
  }

  private getMarkItDown() {
    return this.app.pm?.get?.('plugin-markitdown-parser') || this.app.pm?.get?.('markitdown-parser');
  }

  private async writeTempFile(buffer: Buffer, extname: string) {
    const safeExt = extname.startsWith('.') ? extname : `.${extname}`;
    const filePath = path.join(
      os.tmpdir(),
      `nocobase-file-search-${Date.now()}-${randomBytes(6).toString('hex')}${safeExt}`,
    );
    await fsp.writeFile(filePath, buffer);
    return filePath;
  }
}
