/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Database } from '@nocobase/database';

const REPO_NAME = 'aiKnowledgeBaseDocumentVersions';
const MAX_VERSIONS_PER_DOCUMENT = 20;

export type CreateVersionOptions = {
  documentId: string;
  textContent?: string | null;
  filename?: string;
  changeType?: 'initial' | 'update' | 'reprocess' | 'restore';
  metadata?: Record<string, unknown>;
  createdBy?: number | string | null;
};

/**
 * Snapshot-based version history for KB documents with text content.
 *
 * - A new version is created when textContent changes (update/restore) or
 *   on first vectorization (initial).
 * - Versions are capped per document; oldest versions beyond the cap are pruned.
 */
export class DocumentVersionService {
  constructor(private readonly db: Database) {}

  async recordVersion(options: CreateVersionOptions): Promise<number | null> {
    const repo = this.db.getRepository(REPO_NAME);
    if (!repo || !options.documentId) return null;

    // Only snapshot text-content documents (file-only docs don't have comparable content)
    if (options.textContent == null && options.changeType !== 'initial') {
      return null;
    }

    const existing = await repo.find({
      filter: { documentId: options.documentId },
      fields: ['id', 'version', 'textContent'],
      sort: ['-version'],
      limit: 1,
    });

    const latest = Array.isArray(existing) ? existing[0] : undefined;
    const latestVersion = latest?.version ?? 0;

    // Skip duplicate snapshots for identical content on non-initial changes
    if (
      latest &&
      options.textContent != null &&
      typeof latest.get === 'function' &&
      latest.get('textContent') === options.textContent &&
      options.changeType !== 'initial'
    ) {
      return null;
    }

    await repo.create({
      values: {
        documentId: options.documentId,
        version: latestVersion + 1,
        textContent: options.textContent ?? null,
        filename: options.filename ?? null,
        changeType: options.changeType ?? 'update',
        metadata: options.metadata ?? {},
        createdBy: options.createdBy ?? null,
        createdAt: new Date(),
      },
    });

    await this.pruneOldVersions(options.documentId);
    return latestVersion + 1;
  }

  async listVersions(documentId: string): Promise<any[]> {
    const repo = this.db.getRepository(REPO_NAME);
    if (!repo || !documentId) return [];

    const records = await repo.find({
      filter: { documentId },
      fields: ['id', 'version', 'filename', 'changeType', 'createdBy', 'createdAt', 'textContent'],
      sort: ['-version'],
      limit: MAX_VERSIONS_PER_DOCUMENT,
    });

    return records.map((record: any) => {
      const data = record.toJSON ? record.toJSON() : record;
      return {
        ...data,
        contentPreview: typeof data.textContent === 'string' ? data.textContent.slice(0, 300) : '',
        contentLength: typeof data.textContent === 'string' ? data.textContent.length : 0,
        textContent: undefined,
      };
    });
  }

  async getVersion(documentId: string, version: number): Promise<any | null> {
    const repo = this.db.getRepository(REPO_NAME);
    if (!repo || !documentId || !Number.isFinite(version)) return null;

    const record = await repo.findOne({
      filter: { documentId, version },
    });

    return record ?? null;
  }

  /**
   * Restore a previous version's text content into the document and
   * re-queue it for vectorization. Returns the document ID when restore
   * was performed, or null when not possible.
   */
  async restoreVersion(
    documentId: string,
    version: number,
    enqueueDocument?: (docId: string) => Promise<void>,
    userId?: number | string | null,
  ): Promise<{ restored: boolean; error?: string }> {
    const docRepo = this.db.getRepository('aiKnowledgeBaseDocuments');
    const targetVersion = await this.getVersion(documentId, version);

    if (!targetVersion) {
      return { restored: false, error: `Version ${version} not found` };
    }
    if (targetVersion.textContent == null) {
      return { restored: false, error: `Version ${version} has no text content to restore` };
    }

    const doc = await docRepo.findOne({ filter: { id: documentId } });
    if (!doc) {
      return { restored: false, error: 'Document not found' };
    }
    if (doc.get?.('status') === 'processing') {
      return { restored: false, error: 'Cannot restore while document is processing' };
    }

    // Snapshot current state before restoring so nothing is lost
    const currentText = doc.get?.('textContent') ?? null;
    if (currentText != null) {
      await this.recordVersion({
        documentId,
        textContent: currentText,
        filename: doc.get?.('filename'),
        changeType: 'reprocess',
        createdBy: userId ?? null,
      });
    }

    await docRepo.update({
      filterByTk: documentId,
      values: {
        textContent: targetVersion.textContent,
        status: 'pending',
        error: null,
        chunkCount: 0,
        retryCount: 0,
      },
    });

    // Record the restore itself as a new version
    await this.recordVersion({
      documentId,
      textContent: targetVersion.textContent,
      filename: targetVersion.filename ?? doc.get?.('filename'),
      changeType: 'restore',
      metadata: { restoredFromVersion: version },
      createdBy: userId ?? null,
    });

    if (enqueueDocument) {
      await enqueueDocument(documentId);
    }

    return { restored: true };
  }

  private async pruneOldVersions(documentId: string): Promise<void> {
    const repo = this.db.getRepository(REPO_NAME);
    if (!repo) return;

    const records = await repo.find({
      filter: { documentId },
      fields: ['id'],
      sort: ['-version'],
      offset: MAX_VERSIONS_PER_DOCUMENT,
    });

    const ids = records.map((r: any) => r.id).filter(Boolean);
    if (!ids.length) return;
    await repo.destroy({ filter: { id: { $in: ids } } });
  }
}
