// SPDX-License-Identifier: Apache-2.0

import { resolve as resolvePath, sep } from 'path';
import { access, readFile } from 'fs/promises';
import { createHash } from 'crypto';
import type PluginKnowledgeBaseServer from '../plugin';
import { DocumentTextSplitter } from './text-splitter';
import type { TextSplitterOptions } from './text-splitter';
import { createEmbeddingsForVectorStore } from './embedding-factory';
import type { DocPixieExtractor } from '../services/docpixie-extractor';
import { KnowledgeSearchService } from '../services/knowledge-search';
import { detectLanguage, getChunkSizeMultiplier, getSeparatorsForLanguage } from '../services/language-detect';
import { WebhookDispatcher } from '../services/webhook';
import { deleteIndexRevision } from '../services/index-lifecycle';

export type VectorizationResult = {
  success: boolean;
  chunkCount: number;
  error?: string;
};

/**
 * Orchestrates the full document vectorization pipeline:
 *
 * 1. Parse uploaded file (DocPixie → plugin-ai loaders → raw bytes fallback)
 * 2. Split text into chunks using RecursiveCharacterTextSplitter
 * 3. Embed chunks and store in vector DB via VectorStoreService
 * 4. Update document status in database
 *
 * When the knowledge base has `useDocpixie=true` and plugin-docpixie is active:
 *  - DocPixie is used for text extraction (better OCR/structure for scanned PDFs)
 *  - The DocPixie document ID is stored in chunk metadata (`docpixieDocumentId`)
 *  - This enables Stage 2 deep retrieval in the work context handler
 */
const webhookDispatcher = new WebhookDispatcher();

export class VectorizationPipeline {
  constructor(
    private plugin: PluginKnowledgeBaseServer,
    private docpixieExtractor?: DocPixieExtractor,
  ) {}

  async processDocument(documentId: string, options?: TextSplitterOptions): Promise<VectorizationResult> {
    const docRepo = this.plugin.db.getRepository('aiKnowledgeBaseDocuments');
    const attempt = await this.plugin.indexLifecycle.begin(documentId);
    if (!attempt) return { success: true, chunkCount: 0 };
    const { revision, token, vectorStore } = attempt;
    let activated = false;
    let completedChunks = 0;

    try {
      // Fix P1-5: Replaced unreliable 500ms sleep with polling retry.
      // Polls for FK relation visibility with exponential backoff (200ms → 5s ceiling).
      // Faster on happy path, more reliable under replica lag.
      const MAX_FK_WAIT_MS = 5000;
      const FK_POLL_BASE_MS = 200;
      let docRecord: any = null;
      let waitedMs = 0;
      let attempt = 0;

      while (waitedMs < MAX_FK_WAIT_MS) {
        docRecord = await docRepo.findOne({
          filter: { id: documentId },
          appends: ['file', 'knowledgeBase'],
        });

        if (docRecord && docRecord.get('knowledgeBaseId') && docRecord.knowledgeBase) {
          break; // FK relations are visible
        }

        attempt++;
        const delayMs = Math.min(FK_POLL_BASE_MS * Math.pow(2, attempt - 1), 2000);
        this.plugin.app.logger.debug(
          `[Vectorization] FK not yet visible for doc ${documentId}, poll attempt ${attempt} (waiting ${delayMs}ms)...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        waitedMs += delayMs;
      }

      // Final attempt if we exhausted the wait
      if (!docRecord || !docRecord.knowledgeBase) {
        docRecord = await docRepo.findOne({
          filter: { id: documentId },
          appends: ['file', 'knowledgeBase'],
        });
      }

      if (!docRecord) {
        throw new Error(`Document "${documentId}" not found`);
      }

      const doc = docRecord.toJSON();
      const file = doc.file;
      const textContent = doc.textContent;
      const knowledgeBase = doc.knowledgeBase;

      if (!file && !textContent) {
        throw new Error('Document has no associated file or text content');
      }

      if (!knowledgeBase) throw new Error('Knowledge base is unavailable');

      // 2. Get the text content — try DocPixie → plugin-ai loaders → raw fallback
      let rawText = '';
      let docpixieDocumentId: number | null = null;

      if (textContent) {
        // Direct text content (pasted text) — skip file parsing entirely
        rawText = textContent;
      } else {
        // Resolve local file path (needed for both DocPixie and raw fallback)
        const resolvedPath = this.resolveLocalPath(file);

        // ── DocPixie extraction (highest priority when enabled) ────────────────
        if (knowledgeBase.useDocpixie && this.docpixieExtractor?.isAvailable() && resolvedPath) {
          const filename = file.filename ?? doc.filename ?? 'document';
          const result = await this.docpixieExtractor.extractFromPath(
            resolvedPath,
            filename,
            doc.uploadedById ?? undefined,
          );
          if (result) {
            rawText = result.text;
            docpixieDocumentId = result.documentId;
            this.plugin.app.logger.info(
              `[Vectorization] DocPixie extraction: doc="${filename}" docpixie_id=${result.documentId} chars=${result.text.length}`,
            );
          }
        }

        // ── plugin-ai DocumentLoaders fallback ────────────────────────────────
        if (!rawText) {
          const aiPlugin = this.plugin.aiPlugin;
          if (aiPlugin.documentLoaders?.cached) {
            const parseResult = await aiPlugin.documentLoaders.cached.load(file);
            if (!parseResult.supported) {
              throw new Error(`File type not supported: ${file.filename}`);
            }
            rawText = parseResult.text || '';
          } else if (resolvedPath) {
            // ── Raw bytes fallback ───────────────────────────────────────────
            try {
              await access(resolvedPath);
            } catch {
              throw new Error(`File not found at: ${resolvedPath}`);
            }
            rawText = await readFile(resolvedPath, 'utf-8');
          } else {
            throw new Error(`Cannot resolve file for: ${file.filename}`);
          }
        }
      }

      if (!rawText || rawText.trim().length === 0) {
        await this.plugin.indexLifecycle.activate(documentId, revision, token, {
          chunkCount: 0,
          ...(docpixieDocumentId ? { meta: { ...(doc.meta ?? {}), docpixieDocumentId } } : {}),
        });
        return { success: true, chunkCount: 0 };
      }

      // 3. Split text into chunks — include permission + DocPixie metadata.
      // Multi-language: detect dominant script and adjust separators/chunk size so that
      // CJK/Vietnamese/Thai content splits at natural sentence boundaries.
      const detectedLang = detectLanguage(rawText);
      const langMultiplier = getChunkSizeMultiplier(detectedLang);
      const effectiveOptions = {
        ...(options ?? {}),
        ...(options?.chunkSize ? {} : { chunkSize: Math.round(1000 * langMultiplier) }),
        ...(!options?.separators && getSeparatorsForLanguage(detectedLang)
          ? { separators: getSeparatorsForLanguage(detectedLang) }
          : {}),
      };
      const splitter = new DocumentTextSplitter(effectiveOptions);
      const chunks = await splitter.splitText(rawText, {
        knowledgeBaseId: knowledgeBase.id,
        knowledgeBaseOuterId: knowledgeBase.id,
        documentId,
        indexRevision: revision,
        source: file?.filename ?? doc.filename ?? 'pasted-text',
        // Permission metadata for vector-level filtering
        userId: doc.uploadedById ?? null,
        accessLevel: knowledgeBase.accessLevel ?? 'PUBLIC',
        // DocPixie reference for Stage 2 deep retrieval (null if not used)
        ...(docpixieDocumentId ? { docpixieDocumentId } : {}),
        // Detected content language for language-aware retrieval/filtering
        language: detectedLang,
      });

      if (chunks.length === 0) {
        await this.plugin.indexLifecycle.activate(documentId, revision, token, {
          chunkCount: 0,
          ...(docpixieDocumentId ? { meta: { ...(doc.meta ?? {}), docpixieDocumentId } } : {}),
        });
        return { success: true, chunkCount: 0 };
      }

      // 4. Store chunks in vector DB
      const vectorDatabase = vectorStore.vectorDatabase;

      // Create embedding model from the vector store's LLM service config.
      const embeddings = await createEmbeddingsForVectorStore(this.plugin, vectorStore);

      // Create vector store instance
      const vdbProvider = this.plugin.aiPlugin.features.vectorDatabaseProvider;
      const vectorStoreInstance = await vdbProvider.createVectorStore(
        vectorDatabase.provider,
        embeddings,
        vectorDatabase.connectParams,
      );

      // Each attempt has a new revision; deterministic IDs prevent ambiguous chunk identity.
      const ids = chunks.map((_, index) => {
        const hash = createHash('sha256').update(`${revision}:${index}`).digest('hex');
        return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(
          20,
          32,
        )}`;
      });
      await vectorStoreInstance.addDocuments(chunks, { ids });

      // 5. Update status to success — persist docpixieDocumentId in meta for future reference
      activated = await this.plugin.indexLifecycle.activate(documentId, revision, token, {
        chunkCount: chunks.length,
        meta: {
          ...(doc.meta ?? {}),
          ...(docpixieDocumentId ? { docpixieDocumentId } : {}),
        },
      });
      if (!activated) {
        try {
          await deleteIndexRevision(
            vectorDatabase.provider,
            vectorDatabase.connectParams,
            String(knowledgeBase.id),
            String(documentId),
            revision,
          );
        } catch {
          this.plugin.app.logger.warn(`[Vectorization] Deferred stale revision cleanup for ${documentId}.`);
        }
        return { success: true, chunkCount: 0 };
      }
      completedChunks = chunks.length;

      // Invalidate cached search results for this KB — new chunks are searchable now
      KnowledgeSearchService.invalidateKnowledgeBase(String(knowledgeBase.id ?? knowledgeBase.knowledgeBaseOuterId));

      // Snapshot the initial text-content version once vectorization succeeds
      if (textContent && this.plugin.documentVersionService) {
        await this.plugin.documentVersionService.recordVersion({
          documentId,
          textContent,
          filename: knowledgeBase.filename ?? doc.filename ?? 'pasted-text',
          changeType: 'initial',
          metadata: { chunkCount: chunks.length, source: 'vectorization' },
          createdBy: doc.uploadedById ?? null,
        });
      }

      // 6. Auto-delete source file if KB has deleteSourceFile enabled
      if (knowledgeBase.deleteSourceFile && file) {
        const deleted = await this.plugin.indexLifecycle.deleteOwnedSourceFile(documentId, revision);
        if (!deleted)
          this.plugin.app.logger.warn(
            `[Vectorization] Source file retained for ${documentId}: ownership, references or current revision could not be verified.`,
          );
      }

      await webhookDispatcher.dispatch('document.vectorized', {
        knowledgeBaseId: String(knowledgeBase.id ?? knowledgeBase.knowledgeBaseOuterId ?? ''),
        documentId: String(documentId),
        filename: file?.filename ?? doc.filename ?? 'pasted-text',
        chunkCount: chunks.length,
      });

      return { success: true, chunkCount: chunks.length };
    } catch {
      if (activated) {
        this.plugin.app.logger.warn(`[Vectorization] Post-activation task failed for ${documentId}.`);
        return { success: true, chunkCount: completedChunks };
      }
      const message = 'Document vectorization failed';
      await this.plugin.indexLifecycle.fail(documentId, revision, token, message);

      await webhookDispatcher.dispatch('document.failed', {
        documentId: String(documentId),
        error: message,
      });

      return {
        success: false,
        chunkCount: 0,
        error: message,
      };
    }
  }

  /**
   * Resolve a storage-relative or absolute path from a file record.
   * Returns null if the path cannot be resolved to a local file
   * (e.g., remote S3 URL).
   *
   * Fix #5: The allowed root is now `storage/uploads` — not the entire CWD —
   * to prevent path traversal attacks that could read source files or configs.
   */
  private resolveLocalPath(file: any): string | null {
    let filePath: string = file.path || file.url || '';
    if (!filePath) return null;

    // Remote URL — cannot use as a local path
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) return null;

    if (filePath.startsWith('/storage/') || filePath.startsWith('storage/')) {
      const storageBase = resolvePath(process.cwd(), 'storage');
      filePath = resolvePath(storageBase, filePath.replace(/^\/?(?:storage\/)?/, ''));
    }

    // Prevent path traversal: only allow paths under storage/uploads
    const allowedRoot = resolvePath(process.cwd(), 'storage', 'uploads');
    if (!filePath.startsWith(allowedRoot + sep) && filePath !== allowedRoot) {
      this.plugin.app.logger.warn(
        `[Vectorization] Blocked path traversal attempt: "${filePath}" is outside storage/uploads`,
      );
      return null;
    }

    return filePath;
  }
}
