/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Database } from '@nocobase/database';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';

export type DocPixieExtractionResult = {
  /** Concatenated text from all DocPixie pages (in page order) */
  text: string;
  /** ID of the created DocPixie document record */
  documentId: number;
};

/**
 * Wraps plugin-docpixie's OCR/rendering pipeline for use inside knowledge-base vectorization.
 *
 * Usage:
 *   const extractor = new DocPixieExtractor(db, () => pm.get('@nocobase/plugin-docpixie'));
 *   const result = await extractor.extractFromPath('/tmp/file.pdf', 'report.pdf', userId);
 *   if (result) { rawText = result.text; docpixieDocumentId = result.documentId; }
 */
export class DocPixieExtractor {
  constructor(
    private readonly db: Database,
    private readonly getDocpixiePlugin: () => any | null,
  ) {}

  /** Returns true if plugin-docpixie is loaded and ready (configured + LLM provider set) */
  isAvailable(): boolean {
    const plugin = this.getDocpixiePlugin();
    return !!plugin?.service?.isReady();
  }

  /**
   * Extract text from a local file path.
   * processDocument() is synchronous — it waits for full OCR + summarization before returning.
   * Returns null on any failure so callers can fall through to the next extractor.
   */
  async extractFromPath(filePath: string, filename: string, userId?: number): Promise<DocPixieExtractionResult | null> {
    const plugin = this.getDocpixiePlugin();
    if (!plugin?.service?.isReady()) return null;

    try {
      const documentId: number = await plugin.service.processDocument(filePath, {
        name: filename,
        userId,
      });

      const text = await this.getPageTexts(documentId);
      return { text, documentId };
    } catch {
      return null;
    }
  }

  /**
   * Extract text from an in-memory buffer (for files already downloaded, e.g. from S3).
   * Writes to a temp file, runs DocPixie extraction, then cleans up.
   */
  async extractFromBuffer(
    buffer: Buffer,
    filename: string,
    extname: string,
    userId?: number,
  ): Promise<DocPixieExtractionResult | null> {
    const plugin = this.getDocpixiePlugin();
    if (!plugin?.service?.isReady()) return null;

    const ext = extname.startsWith('.') ? extname : `.${extname}`;
    const tempPath = join(tmpdir(), `kb-docpixie-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);

    try {
      await writeFile(tempPath, buffer);
      return await this.extractFromPath(tempPath, filename, userId);
    } finally {
      if (existsSync(tempPath)) {
        unlink(tempPath).catch(() => {});
      }
    }
  }

  /**
   * Concatenate all page texts for a DocPixie document, ordered by page number.
   * Queries the docpixie_pages collection directly.
   */
  async getPageTexts(documentId: number): Promise<string> {
    const pageRepo = this.db.getRepository('docpixie_pages');
    const pages = await pageRepo.find({
      filter: { documentId },
      sort: ['pageNumber'],
    });
    return pages
      .map((p: any) => (p.get('structuredText') as string) || '')
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * Fetch the summary + page texts for a set of DocPixie document IDs.
   * Used in Stage 2 deep retrieval during AI chat work context.
   *
   * Returns a formatted string ready to be injected into the AI prompt.
   * Caps at maxDocs documents to avoid blowing the context window.
   */
  async buildDeepContext(documentIds: number[], maxDocs = 3): Promise<string> {
    if (!documentIds.length) return '';

    const docRepo = this.db.getRepository('docpixie_documents');
    const ids = documentIds.slice(0, maxDocs);

    const parts: string[] = [];

    for (const id of ids) {
      try {
        const docRecord = await docRepo.findOne({ filter: { id } });
        if (!docRecord) continue;

        const status = docRecord.get('status') as string;
        const name = docRecord.get('name') as string;
        const summary = docRecord.get('summary') as string | undefined;

        // Only use docs that have finished processing
        if (status !== 'ready') continue;

        const pageText = await this.getPageTexts(id);
        if (!pageText && !summary) continue;

        const content = pageText || summary || '';
        parts.push(`<docpixie_document id="${id}" name="${name}">\n${content}\n</docpixie_document>`);
      } catch {
        // Skip individual failures — don't abort the whole context build
      }
    }

    return parts.join('\n\n');
  }
}
