/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import type { Document } from '@langchain/core/documents';

export type TextSplitterOptions = {
  chunkSize?: number;
  chunkOverlap?: number;
  separators?: string[];
};

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 200;

export class DocumentTextSplitter {
  private splitter: RecursiveCharacterTextSplitter;

  constructor(options?: TextSplitterOptions) {
    const { chunkSize = DEFAULT_CHUNK_SIZE, chunkOverlap = DEFAULT_CHUNK_OVERLAP, separators } = options ?? {};

    this.splitter = new RecursiveCharacterTextSplitter({
      chunkSize,
      chunkOverlap,
      ...(separators ? { separators } : {}),
    });
  }

  async splitText(text: string, metadata?: Record<string, any>): Promise<Document[]> {
    if (!text || text.trim().length === 0) {
      return [];
    }

    const documents = await this.splitter.createDocuments([text], [metadata ?? {}]);

    return documents;
  }

  async splitDocuments(documents: Document[]): Promise<Document[]> {
    if (!documents || documents.length === 0) {
      return [];
    }

    return this.splitter.splitDocuments(documents);
  }
}
