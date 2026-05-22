/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * DocPixieService — Core Document Processing Service
 *
 * Orchestrates the full document lifecycle within NocoBase:
 *
 *   1. Upload & render (PDF → page images via external service)
 *   2. Extract text (OCR provider or text layer)
 *   3. Store structured data (NocoBase collections)
 *   4. Summarize document (LLM)
 *   5. Query across documents (Adaptive RAG Agent)
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  NocoBase Action                                           │
 * │       │                                                    │
 * │       ▼                                                    │
 * │  DocPixieService                                           │
 * │       ├── NocoBaseLLMAdapter  (wraps plugin-ai providers)  │
 * │       ├── OCR Provider        (external_api or none)       │
 * │       └── Repository          (NocoBase DB CRUD)           │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Adapted from the draft @docpixie/plugin-docpixie to use NocoBase's native
 * LLM infrastructure (plugin-ai + plugin-custom-llm) instead of standalone
 * OpenAICompatibleProvider.
 *
 * Usage from plugin.ts:
 *   const service = new DocPixieService(app, db, logger);
 *   await service.initialize();
 *   const doc = await service.processDocument('/path/to/file.pdf');
 *   const result = await service.query({ query: 'What is Q3 revenue?' });
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Database } from '@nocobase/database';
import { Logger } from '@nocobase/logger';
import { Application } from '@nocobase/server';
import type {
  DocPixiePluginConfig,
  DocPixieQueryInput,
  DocPixieQueryResult,
  PageExtraction,
  SourcePage,
  TaskSummary,
  ILLMProvider,
  IOCRProvider,
  AnalysisStrategy,
  ConversationTurn,
  OCRProviderType,
} from '../types';
import {
  SYSTEM_DOCPIXIE,
  SYSTEM_DIRECT_ANSWER,
  SYSTEM_SYNTHESIS,
  SYSTEM_SUMMARIZER,
  SYSTEM_QUERY_REFORMULATOR,
  SYSTEM_QUERY_CLASSIFIER,
  SYSTEM_TASK_PLANNER,
  SYSTEM_ADAPTIVE_PLANNER,
  SYSTEM_PAGE_SELECTOR,
  TASK_PROCESSING_PROMPT,
  SYNTHESIS_PROMPT,
  ADAPTIVE_INITIAL_PLANNING_PROMPT,
  ADAPTIVE_PLAN_UPDATE_PROMPT,
  VISION_PAGE_SELECTION_PROMPT,
  TEXT_PAGE_SELECTION_PROMPT,
  QUERY_REFORMULATION_PROMPT,
  QUERY_CLASSIFICATION_PROMPT,
  CONVERSATION_SUMMARIZATION_PROMPT,
  fillPrompt,
} from '../prompts';
import { NocoBaseLLMAdapter } from '../providers/llm-adapter';
import {
  DocPixieError,
  ContextProcessingError,
  QueryReformulationError,
  QueryClassificationError,
  TaskPlanningError,
  PageSelectionError,
  TaskAnalysisError,
  PlanUpdateError,
  ResponseSynthesisError,
  ProcessingError,
  ProviderError,
} from '../exceptions';

/** Supported file extensions for direct processing */
const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif']);

/** MIME types for base64 data URLs */
const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.pdf': 'application/pdf',
};

// ─────────────────────────────────────────────
// Internal Types for Adaptive Planning
// ─────────────────────────────────────────────

type AgentTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** A single task in the adaptive plan */
interface AgentTask {
  id: string;
  name: string;
  description: string;
  documentId: number;
  documentName: string;
  status: AgentTaskStatus;
}

/** The full adaptive task plan — supports add/remove/modify */
interface TaskPlan {
  initialQuery: string;
  tasks: AgentTask[];
  currentIteration: number;
  maxIterations: number;

  hasPendingTasks(): boolean;
  getNextPendingTask(): AgentTask | null;
  getCompletedTasks(): AgentTask[];
  addTask(task: Omit<AgentTask, 'id' | 'status'>): AgentTask;
  removeTask(taskId: string): boolean;
}

/** Create a TaskPlan instance with helper methods */
function createTaskPlan(query: string, tasks: Omit<AgentTask, 'id' | 'status'>[], maxIterations: number): TaskPlan {
  const plan: TaskPlan = {
    initialQuery: query,
    tasks: tasks.map((t) => ({
      ...t,
      id: `task_${Math.random().toString(36).substring(2, 9)}`,
      status: 'pending' as AgentTaskStatus,
    })),
    currentIteration: 0,
    maxIterations,

    hasPendingTasks() {
      return this.tasks.some((t) => t.status === 'pending');
    },
    getNextPendingTask() {
      return this.tasks.find((t) => t.status === 'pending') || null;
    },
    getCompletedTasks() {
      return this.tasks.filter((t) => t.status === 'completed');
    },
    addTask(task) {
      const newTask: AgentTask = {
        ...task,
        id: `task_${Math.random().toString(36).substring(2, 9)}`,
        status: 'pending',
      };
      this.tasks.push(newTask);
      return newTask;
    },
    removeTask(taskId: string) {
      const idx = this.tasks.findIndex((t) => t.id === taskId && t.status === 'pending');
      if (idx === -1) return false;
      this.tasks.splice(idx, 1);
      return true;
    },
  };
  return plan;
}

export class DocPixieService {
  private app: Application;
  private db: Database;
  private logger: any;
  private config: DocPixiePluginConfig | null = null;
  private llmProvider: ILLMProvider | null = null;
  private ocrProvider: IOCRProvider | null = null;

  constructor(app: Application, db: Database, logger: any) {
    this.app = app;
    this.db = db;
    this.logger = logger;
  }

  // ═══════════════════════════════════════════
  // Initialization
  // ═══════════════════════════════════════════

  /**
   * Initialize the service with plugin configuration.
   *
   * Loads config from `docpixie_config` collection, resolves LLM providers
   * from NocoBase's plugin-ai infrastructure, and validates connectivity.
   *
   * Called during plugin `load()` and after config changes.
   *
   * @throws Error if config is missing or providers fail validation
   */
  async initialize(config?: DocPixiePluginConfig): Promise<void> {
    if (config) {
      this.config = config;
    } else {
      this.config = await this.loadConfig();
    }

    if (!this.config) {
      this.logger.warn('DocPixie: No configuration found. Plugin will be inactive.');
      return;
    }

    // Create LLM provider adapter using NocoBase's LLM infrastructure
    this.llmProvider = await this.resolveNocoBaseLLMProvider(this.config);

    // Create OCR provider based on config
    this.ocrProvider = this.createOCRProvider(this.config);

    this.logger.info('DocPixie service initialized', {
      strategy: this.config.analysisStrategy,
      ocrProvider: this.config.ocrProvider,
      llmService: this.config.llmServiceName,
      visionLlmService: this.config.visionLlmServiceName,
    });
  }

  /**
   * Check whether the service is ready to process documents and queries.
   */
  isReady(): boolean {
    return !!(this.config && this.llmProvider);
  }

  // ═══════════════════════════════════════════
  // Document Processing
  // ═══════════════════════════════════════════

  /**
   * Process a document file through the full ingestion pipeline:
   *
   * 1. Validate file exists and is a supported type (.pdf, .jpg, .png, ...)
   * 2. Copy file to storage
   * 3. Detect if page has text layer (digital PDF) or needs OCR (scanned)
   * 4. Extract structured text per page (OCR or text layer)
   * 5. Store document + pages in NocoBase collections
   * 6. Generate document summary via LLM
   * 7. Update document status to 'ready'
   *
   * @param filePath - Absolute path to the source document
   * @param options  - Optional overrides
   * @returns Created document record ID
   */
  async processDocument(filePath: string, options?: { name?: string; userId?: number }): Promise<number> {
    this.ensureReady();

    const docRepo = this.db.getRepository('docpixie_documents');
    const pageRepo = this.db.getRepository('docpixie_pages');

    // ① Create document record with 'pending' status
    const doc = await docRepo.create({
      values: {
        name: options?.name || this.extractFileName(filePath),
        originalPath: filePath,
        status: 'pending',
        extractionMethod: this.config!.ocrProvider,
        createdById: options?.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const documentId = doc.get('id') as number;

    try {
      // ② Update status to 'extracting'
      await docRepo.update({
        filterByTk: documentId,
        values: { status: 'extracting' },
      });

      // ③ Render pages to images + extract structured text
      const pages = await this.extractPages(filePath, documentId);

      // ④ Store page records
      for (const page of pages) {
        await pageRepo.create({
          values: {
            documentId,
            pageNumber: page.pageNumber,
            imagePath: page.imagePath,
            structuredText: page.structuredText,
            regions: page.regions,
            hasTables: page.hasTables,
            hasFigures: page.hasFigures,
            headings: page.headings,
            extractionMethod: page.extractionMethod,
          },
        });
      }

      // ⑤ Generate document summary
      await docRepo.update({
        filterByTk: documentId,
        values: { status: 'summarizing' },
      });

      const summary = await this.generateSummary(documentId, pages);

      // ⑥ Finalize document
      await docRepo.update({
        filterByTk: documentId,
        values: {
          status: 'ready',
          pageCount: pages.length,
          summary,
          updatedAt: new Date(),
        },
      });

      this.logger.info(`DocPixie: Document processed — id=${documentId}, pages=${pages.length}`);
      return documentId;
    } catch (error) {
      // Mark as failed
      await docRepo.update({
        filterByTk: documentId,
        values: { status: 'failed', metadata: { error: String(error) } },
      });
      this.logger.error(`DocPixie: Document processing failed — id=${documentId}`, error);
      throw error;
    }
  }

  /**
   * Extract text from a file buffer without indexing it into the document store.
   * Used for transient extraction (e.g. AI employee chat attachments).
   *
   * @param buffer   - Raw file contents
   * @param filename - Original filename (used to determine extension)
   * @returns Extracted text, one section per page separated by "\n\n"
   */
  /**
   * Extract text from a file that already exists on the local filesystem.
   * Avoids the Buffer → temp-file write overhead when the caller already has
   * a resolved absolute path (e.g. local-storage attachments).
   */
  // ═══════════════════════════════════════════
  // Full-pipeline processing for chat attachments
  // ═══════════════════════════════════════════

  /**
   * Full DocPixie ingestion pipeline for a file that already exists on the local filesystem.
   * Creates an indexed, queryable document record in the DB.
   *
   * Use this when the AI employee has the DocPixie skill and the file is a local-storage
   * attachment — no extra temp-file write needed since the file already exists on disk.
   *
   * @returns { documentId, summary, pageCount } — use documentId with the RAG tool
   */
  async processDocumentFromPath(
    filePath: string,
    filename?: string,
    options?: { userId?: number },
  ): Promise<{ documentId: number; summary: string; pageCount: number }> {
    this.ensureReady();

    const name = filename || path.basename(filePath);
    const ext = path.extname(name).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      throw new ProcessingError(
        `Unsupported file type: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`,
        name,
      );
    }

    const documentId = await this.processDocument(filePath, { name, userId: options?.userId });
    const doc = await this.getDocument(documentId);
    return {
      documentId,
      summary: (doc?.get?.('summary') as string) || '',
      pageCount: (doc?.get?.('pageCount') as number) || 0,
    };
  }

  /**
   * Full DocPixie ingestion pipeline for a file provided as an in-memory Buffer.
   * Writes the buffer to a temp file, runs the pipeline, then cleans up.
   *
   * Use this for remote/S3 attachments where only the Buffer is available.
   *
   * @returns { documentId, summary, pageCount } — use documentId with the RAG tool
   */
  async processDocumentFromBuffer(
    buffer: Buffer,
    filename: string,
    options?: { userId?: number },
  ): Promise<{ documentId: number; summary: string; pageCount: number }> {
    this.ensureReady();

    const ext = path.extname(filename).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      throw new ProcessingError(
        `Unsupported file type: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`,
        filename,
      );
    }

    const uid = randomUUID().replace(/-/g, '').slice(0, 12);
    const tmpDir = path.join(process.cwd(), 'storage', 'docpixie', 'tmp');
    await fsPromises.mkdir(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `${uid}${ext}`);

    try {
      await fsPromises.writeFile(tmpFile, buffer);
      // processDocument copies the file into storage — temp can be deleted after
      const documentId = await this.processDocument(tmpFile, { name: filename, userId: options?.userId });
      const doc = await this.getDocument(documentId);
      return {
        documentId,
        summary: (doc?.get?.('summary') as string) || '',
        pageCount: (doc?.get?.('pageCount') as number) || 0,
      };
    } finally {
      try {
        await fsPromises.unlink(tmpFile);
      } catch (_e) {
        /* ignore */
      }
    }
  }

  async extractTextFromPath(filePath: string, filename?: string): Promise<string> {
    this.ensureReady();
    const name = filename || path.basename(filePath);
    const ext = path.extname(name).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      throw new ProcessingError(
        `Unsupported file type: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`,
        name,
      );
    }

    const uid = randomUUID().replace(/-/g, '').slice(0, 12);
    const tmpDocId = -((parseInt(uid, 16) % 2_000_000_000) + 1);
    const tmpStorageDir = path.join(process.cwd(), 'storage', 'docpixie', String(tmpDocId));

    try {
      const pages = await this.extractPages(filePath, tmpDocId);
      const texts = pages.map((p) => p.structuredText?.trim()).filter(Boolean);
      return texts.join('\n\n');
    } finally {
      try {
        await fsPromises.rm(tmpStorageDir, { recursive: true, force: true });
      } catch (_e) {
        /* ignore */
      }
    }
  }

  async extractTextFromBuffer(buffer: Buffer, filename: string): Promise<string> {
    this.ensureReady();

    const ext = path.extname(filename).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      throw new ProcessingError(
        `Unsupported file type: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`,
        filename,
      );
    }

    // Use a UUID-based pseudo ID to avoid race conditions when multiple attachments
    // are processed concurrently. Negative to never collide with real DB auto-increment IDs.
    const uid = randomUUID().replace(/-/g, '').slice(0, 12);
    const tmpDocId = -((parseInt(uid, 16) % 2_000_000_000) + 1);
    const tmpDir = path.join(process.cwd(), 'storage', 'docpixie', 'tmp');
    await fsPromises.mkdir(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `${uid}${ext}`);
    const tmpStorageDir = path.join(process.cwd(), 'storage', 'docpixie', String(tmpDocId));

    try {
      await fsPromises.writeFile(tmpFile, buffer);
      // extractPages copies file into tmpStorageDir keyed by tmpDocId
      const pages = await this.extractPages(tmpFile, tmpDocId);
      const texts = pages.map((p) => p.structuredText?.trim()).filter(Boolean);
      return texts.join('\n\n');
    } finally {
      try {
        await fsPromises.unlink(tmpFile);
      } catch (_e) {
        /* ignore */
      }
      try {
        await fsPromises.rm(tmpStorageDir, { recursive: true, force: true });
      } catch (_e) {
        /* ignore */
      }
    }
  }

  /**
   * Delete a document and all its pages from the database and filesystem.
   */
  async deleteDocument(documentId: number): Promise<boolean> {
    const docRepo = this.db.getRepository('docpixie_documents');
    const pageRepo = this.db.getRepository('docpixie_pages');

    const doc = await docRepo.findOne({ filterByTk: documentId });
    if (!doc) return false;

    // Delete pages first (cascade)
    await pageRepo.destroy({ filter: { documentId } });

    // Delete document
    await docRepo.destroy({ filterByTk: documentId });

    // Clean up filesystem
    const storageDir = path.join(process.cwd(), 'storage', 'docpixie', String(documentId));
    if (fs.existsSync(storageDir)) {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }

    this.logger.info(`DocPixie: Document deleted — id=${documentId}`);
    return true;
  }

  /**
   * List all documents with their status and page counts.
   */
  async listDocuments(options?: { limit?: number; offset?: number; status?: string }): Promise<any[]> {
    const repo = this.db.getRepository('docpixie_documents');
    const filter: any = {};
    if (options?.status) filter.status = options.status;

    return repo.find({
      filter,
      sort: ['-createdAt'],
      limit: options?.limit || 50,
      offset: options?.offset || 0,
    });
  }

  /**
   * Get a single document with all its pages loaded.
   */
  async getDocument(documentId: number): Promise<any | null> {
    const repo = this.db.getRepository('docpixie_documents');
    return repo.findOne({
      filterByTk: documentId,
      appends: ['pages'],
    });
  }

  // ═══════════════════════════════════════════
  // Query Pipeline
  // ═══════════════════════════════════════════

  /**
   * Execute a document query through the adaptive RAG pipeline.
   *
   * Pipeline steps (mirrors DocPixie's PixieRAGAgent):
   *
   * 1. **Context Processing** — Summarize long conversation history (>8 turns)
   * 2. **Query Reformulation** — Resolve pronoun references ("it" → actual subject)
   * 3. **Query Classification** — Determine if documents are needed
   * 4. **Task Planning** — Create 1-4 tasks, each assigned to one document
   * 5. **Page Selection** — For each task, select relevant pages
   * 6. **Page Analysis** — Extract answer from selected pages
   * 7. **Adaptive Update** — Agent may add/remove/modify tasks
   * 8. **Response Synthesis** — Combine all task results into final answer
   */
  async query(input: DocPixieQueryInput): Promise<DocPixieQueryResult> {
    const startTime = Date.now();
    const strategy = input.strategy || this.config?.analysisStrategy || 'hybrid';
    const documentIds = input.documentIds || [];
    const userId = input.userId;

    try {
      this.ensureReady();

      this.logger.info('DocPixie: Query started', {
        query: input.query.substring(0, 100),
        strategy,
        documentIds: input.documentIds,
      });

      // Reset cost tracking for this query
      this.llmProvider!.resetCost();

      // ──── Step 1: Load documents ────
      const documents = await this.loadQueryDocuments(input.documentIds);
      if (documents.length === 0) {
        const errResult = this.createEmptyResult(input.query, startTime, 'No documents found');
        await this.logQuery({
          query: input.query,
          answer: errResult.answer,
          documentIds,
          strategy,
          confidence: 0,
          totalCost: 0,
          processingTime: (Date.now() - startTime) / 1000,
          status: 'error',
          error: 'No documents found',
          userId,
        });
        return errResult;
      }

      // ──── Step 2: Context processing (if conversation history) ────
      let processedQuery = input.query;
      if (input.conversationHistory && input.conversationHistory.length > 0) {
        processedQuery = await this.reformulateQuery(input.query, input.conversationHistory);
      }

      // ──── Step 3: Query classification ────
      const needsDocuments = await this.classifyQuery(processedQuery);
      if (!needsDocuments) {
        // Direct answer without document analysis
        const directAnswer = await this.getDirectAnswer(processedQuery);
        const result: DocPixieQueryResult = {
          answer: directAnswer,
          sourcePages: [],
          confidence: 0.5,
          totalCost: this.llmProvider!.getTotalCost(),
          processingTime: (Date.now() - startTime) / 1000,
          tasksSummary: [],
        };
        await this.logQuery({
          query: input.query,
          answer: result.answer,
          documentIds,
          strategy,
          confidence: result.confidence,
          totalCost: result.totalCost,
          processingTime: result.processingTime,
          status: 'success',
          userId,
        });
        return result;
      }

      // ──── Step 4: Task planning ────
      const taskPlan = await this.createInitialPlan(processedQuery, documents);

      // ──── Step 5-7: Adaptive task execution loop ────
      const { taskResults, allSourcePages, analysisResults } = await this.executeAdaptivePlan(
        taskPlan,
        processedQuery,
        documents,
        strategy,
        input.conversationHistory,
      );

      // ──── Step 8: Synthesize final answer ────
      const answer = await this.synthesizeResponse(processedQuery, analysisResults);

      const result: DocPixieQueryResult = {
        answer,
        sourcePages: allSourcePages,
        confidence: this.calculateConfidence(taskResults),
        totalCost: this.llmProvider!.getTotalCost(),
        processingTime: (Date.now() - startTime) / 1000,
        tasksSummary: taskResults,
      };

      this.logger.info('DocPixie: Query completed', {
        processingTime: result.processingTime,
        totalCost: result.totalCost,
        tasksCompleted: taskResults.filter((t) => t.status === 'completed').length,
        totalIterations: taskPlan.currentIteration,
      });

      await this.logQuery({
        query: input.query,
        answer: result.answer,
        documentIds,
        strategy,
        confidence: result.confidence,
        totalCost: result.totalCost,
        processingTime: result.processingTime,
        status: 'success',
        userId,
      });

      return result;
    } catch (error: any) {
      const processingTime = (Date.now() - startTime) / 1000;
      const totalCost = this.llmProvider ? this.llmProvider.getTotalCost() : 0;
      this.logger.error(`DocPixie: Query failed — query="${input.query}"`, error);

      await this.logQuery({
        query: input.query,
        answer: `Error: ${error.message}`,
        documentIds,
        strategy,
        confidence: 0,
        totalCost,
        processingTime,
        status: 'error',
        error: error.stack || error.message || String(error),
        userId,
      });

      throw error;
    }
  }

  /**
   * Execute query with user/role scoped document access.
   * Used by AI Tool integration to avoid cross-user data leakage.
   */
  async queryByScope(
    input: DocPixieQueryInput & { userId?: number; roleNames?: string[] },
  ): Promise<DocPixieQueryResult> {
    const startTime = Date.now();
    const isAdmin = this.isAdminRole(input.roleNames);
    const scopedDocuments = await this.loadQueryDocumentsByScope({
      userId: input.userId,
      isAdmin,
      documentIds: input.documentIds,
    });

    if (!scopedDocuments.length) {
      return this.createEmptyResult(input.query, startTime, 'No accessible documents found');
    }

    const scopedDocumentIds = scopedDocuments
      .map((doc: any) => Number(doc.get?.('id') ?? doc.id))
      .filter((id: number) => Number.isFinite(id));

    return this.query({
      query: input.query,
      strategy: input.strategy,
      conversationHistory: input.conversationHistory,
      documentIds: scopedDocumentIds,
      userId: input.userId,
    });
  }

  /**
   * Log query results and metrics to the docpixie_logs collection.
   */
  private async logQuery(logData: {
    query: string;
    answer?: string;
    documentIds: number[];
    strategy: string;
    confidence: number;
    totalCost: number;
    processingTime: number;
    status: 'success' | 'error';
    error?: string;
    userId?: number;
  }): Promise<void> {
    try {
      const logsRepo = this.db.getRepository('docpixie_logs');
      await logsRepo.create({
        values: {
          query: logData.query,
          answer: logData.answer,
          documentIds: logData.documentIds,
          strategy: logData.strategy,
          confidence: logData.confidence,
          totalCost: logData.totalCost,
          processingTime: logData.processingTime,
          status: logData.status,
          error: logData.error,
          userId: logData.userId,
          createdAt: new Date(),
        },
      });
    } catch (err) {
      this.logger.warn('DocPixie: Failed to save query execution log to database', err);
    }
  }

  // ═══════════════════════════════════════════
  // Page Selection Strategies
  // ═══════════════════════════════════════════

  /**
   * Select relevant pages for a task using the configured strategy.
   */
  async selectPages(
    documentId: number,
    taskDescription: string,
    strategy: AnalysisStrategy,
    maxPages = 5,
  ): Promise<number[]> {
    const pageRepo = this.db.getRepository('docpixie_pages');
    const pages = await pageRepo.find({
      filter: { documentId },
      sort: ['pageNumber'],
    });

    if (pages.length === 0) return [];
    if (pages.length <= maxPages) return pages.map((p: any) => p.get('pageNumber'));

    switch (strategy) {
      case 'ocr_only':
        return this.selectPagesByText(pages, taskDescription, maxPages);
      case 'vision':
        return this.selectPagesByVision(pages, taskDescription, maxPages);
      case 'hybrid':
        return this.selectPagesByText(pages, taskDescription, maxPages);
      default:
        return this.selectPagesByText(pages, taskDescription, maxPages);
    }
  }

  /**
   * Select pages by analyzing their structuredText content with text LLM.
   */
  private async selectPagesByText(pages: any[], taskDescription: string, maxPages: number): Promise<number[]> {
    const pageSummaries = pages.map((p: any) => {
      const text = (p.get('structuredText') as string) || '';
      const headings = (p.get('headings') as string[]) || [];
      const preview = text.substring(0, 300);
      return `Page ${p.get('pageNumber')}: [Headings: ${headings.join(', ')}] ${preview}`;
    });

    const prompt = fillPrompt(TEXT_PAGE_SELECTION_PROMPT, {
      task_description: taskDescription,
      page_summaries: pageSummaries.join('\n\n'),
      max_pages: String(maxPages),
    });

    const response = await this.llmProvider!.processTextMessages(
      [
        { role: 'system', content: SYSTEM_PAGE_SELECTOR },
        { role: 'user', content: prompt },
      ],
      200,
      0.1,
    );

    return this.parsePageSelection(response, maxPages);
  }

  /**
   * Select pages by sending their images to the vision LLM.
   */
  private async selectPagesByVision(pages: any[], taskDescription: string, maxPages: number): Promise<number[]> {
    const prompt = fillPrompt(VISION_PAGE_SELECTION_PROMPT, {
      query: taskDescription,
      query_description: taskDescription,
    });

    const messageContent: any[] = [{ type: 'text', text: prompt }];

    // Add each page image (mirrors DocPixie page_selector.py)
    for (const page of pages) {
      const imagePath = page.get('imagePath') as string;
      if (imagePath) {
        messageContent.push({
          type: 'text',
          text: `--- Page ${page.get('pageNumber')} ---`,
        });
        messageContent.push({
          type: 'image_path',
          image_path: imagePath,
          detail: 'low',
        });
      }
    }

    const response = await this.llmProvider!.processMultimodalMessages(
      [
        { role: 'system', content: SYSTEM_PAGE_SELECTOR },
        { role: 'user', content: messageContent },
      ],
      200,
      0.1,
    );

    return this.parsePageSelection(response, maxPages);
  }

  // ═══════════════════════════════════════════
  // Page Analysis
  // ═══════════════════════════════════════════

  /**
   * Analyze selected pages to extract information for a task.
   */
  async analyzePages(
    pages: any[],
    task: string,
    strategy: AnalysisStrategy,
    conversationHistory?: ConversationTurn[],
  ): Promise<string> {
    const memorySummary = this.buildMemorySummary(conversationHistory);

    try {
      switch (strategy) {
        case 'ocr_only':
          return await this.analyzePagesText(pages, task, memorySummary);
        case 'vision':
          return await this.analyzePagesVision(pages, task, memorySummary);
        case 'hybrid':
        default:
          return await this.analyzePagesHybrid(pages, task, memorySummary);
      }
    } catch (err: any) {
      throw new TaskAnalysisError(`Page analysis failed: ${err.message}`);
    }
  }

  /** Analyze pages using only their structured text (cheapest). */
  private async analyzePagesText(pages: any[], task: string, memorySummary: string): Promise<string> {
    const pagesContent = pages
      .map((p: any) => {
        return `=== Page ${p.get('pageNumber')} ===\n${p.get('structuredText') || '(no text)'}`;
      })
      .join('\n\n');

    const prompt = fillPrompt(TASK_PROCESSING_PROMPT, {
      task_description: task,
      search_queries: task,
      memory_summary: memorySummary,
    });

    return this.llmProvider!.processTextMessages(
      [
        { role: 'system', content: SYSTEM_DOCPIXIE },
        { role: 'user', content: `${prompt}\n\nDocument content (OCR text):\n${pagesContent}` },
      ],
      1000,
      0.3,
    );
  }

  /** Analyze pages using only their images (most expensive). */
  private async analyzePagesVision(pages: any[], task: string, memorySummary: string): Promise<string> {
    const prompt = fillPrompt(TASK_PROCESSING_PROMPT, {
      task_description: task,
      search_queries: task,
      memory_summary: memorySummary,
    });

    const content: any[] = [{ type: 'text', text: prompt }];

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      content.push({
        type: 'image_path',
        image_path: page.get('imagePath'),
        detail: 'high',
      });
      content.push({
        type: 'text',
        text: `[Page ${i + 1} from document]`,
      });
    }

    return this.llmProvider!.processMultimodalMessages(
      [
        { role: 'system', content: SYSTEM_DOCPIXIE },
        { role: 'user', content },
      ],
      600,
      0.3,
    );
  }

  /** Analyze pages using structured text as ground truth + images for context. */
  private async analyzePagesHybrid(pages: any[], task: string, memorySummary: string): Promise<string> {
    const prompt = fillPrompt(TASK_PROCESSING_PROMPT, {
      task_description: task,
      search_queries: task,
      memory_summary: memorySummary,
    });

    const content: any[] = [];

    // Provide OCR text as ground truth reference
    const textReference = pages
      .map((p: any) => {
        return `=== Page ${p.get('pageNumber')} (OCR Text) ===\n${p.get('structuredText') || '(no text)'}`;
      })
      .join('\n\n');

    content.push({
      type: 'text',
      text: `${prompt}\n\nOCR text reference (use for exact numbers/data):\n${textReference}\n\nPage images below (use for charts, diagrams, visual context):`,
    });

    // Add page images with high detail
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const imagePath = page.get('imagePath') as string;
      if (imagePath) {
        content.push({ type: 'image_path', image_path: imagePath, detail: 'high' });
        content.push({ type: 'text', text: `[Page ${i + 1} from document]` });
      }
    }

    return this.llmProvider!.processMultimodalMessages(
      [
        {
          role: 'system',
          content: `${SYSTEM_DOCPIXIE}\nWhen citing numbers or data, PRIORITIZE the OCR text reference. Use page images for understanding charts, diagrams, and visual layout.`,
        },
        { role: 'user', content },
      ],
      1000,
      0.3,
    );
  }

  // ═══════════════════════════════════════════
  // Configuration
  // ═══════════════════════════════════════════

  /** Get current plugin configuration from the database. */
  async getConfig(): Promise<DocPixiePluginConfig | null> {
    return this.loadConfig();
  }

  /** Update plugin configuration and reinitialize providers. */
  async updateConfig(config: Partial<DocPixiePluginConfig>): Promise<void> {
    const repo = this.db.getRepository('docpixie_config');
    const existing = await repo.findOne({});

    if (existing) {
      await repo.update({ filterByTk: existing.get('id'), values: config });
    } else {
      await repo.create({ values: config });
    }

    // Reinitialize with new config
    await this.initialize();
    this.logger.info('DocPixie: Configuration updated');
  }

  // ═══════════════════════════════════════════
  // Private Helpers
  // ═══════════════════════════════════════════

  private ensureReady(): void {
    if (!this.isReady()) {
      throw new DocPixieError('DocPixie service is not initialized. Call initialize() first.');
    }
  }

  private async loadConfig(): Promise<DocPixiePluginConfig | null> {
    const repo = this.db.getRepository('docpixie_config');
    const record = await repo.findOne({});
    if (!record) return null;

    return {
      llmServiceName: record.get('llmServiceName') as string,
      visionLlmServiceName: record.get('visionLlmServiceName') as string,
      analysisStrategy: record.get('analysisStrategy') as AnalysisStrategy,
      ocrProvider: record.get('ocrProvider') as OCRProviderType,
      ocrApiEndpoint: record.get('ocrApiEndpoint') as string,
      ocrApiKey: record.get('ocrApiKey') as string,
      maxPagesPerTask: record.get('maxPagesPerTask') as number,
      maxTasksPerPlan: record.get('maxTasksPerPlan') as number,
    };
  }

  /**
   * Resolve LLM providers from NocoBase's plugin-ai infrastructure.
   *
   * This is the KEY integration point — replaces the old createLLMProvider()
   * that used a standalone OpenAICompatibleProvider.
   *
   * Flow:
   *   1. Read llmServiceName from docpixie_config
   *   2. Look up the service in `llmServices` collection
   *   3. Get the registered provider class from aiManager
   *   4. Create provider instance → extract chatModel
   *   5. Wrap in NocoBaseLLMAdapter
   */
  private async resolveNocoBaseLLMProvider(config: DocPixiePluginConfig): Promise<ILLMProvider> {
    if (!config.llmServiceName) {
      this.logger.warn('DocPixie: LLM service name not configured');
      return this.createNoopProvider();
    }

    try {
      // Get plugin-ai's AIManager
      const aiPlugin = this.app.pm.get('ai') as any;
      if (!aiPlugin) {
        throw new ProviderError('plugin-ai is not installed or enabled', 'nocobase-llm');
      }

      const aiManager = aiPlugin.aiManager;
      if (!aiManager) {
        throw new ProviderError('AIManager not available from plugin-ai', 'nocobase-llm');
      }

      // Resolve text model
      const textModel = await this.resolveChatModel(aiManager, config.llmServiceName, 'text');

      // Resolve vision model (may be same service or different)
      const visionServiceName = config.visionLlmServiceName || config.llmServiceName;
      let visionModel = textModel;
      if (visionServiceName !== config.llmServiceName) {
        visionModel = await this.resolveChatModel(aiManager, visionServiceName, 'vision');
      }

      this.logger.info(
        `DocPixie: LLM providers resolved — text: ${config.llmServiceName}, vision: ${visionServiceName}`,
      );
      return new NocoBaseLLMAdapter(textModel, visionModel);
    } catch (err: any) {
      this.logger.error(`DocPixie: Failed to resolve LLM provider: ${err.message}`);
      return this.createNoopProvider();
    }
  }

  /**
   * Resolve a LangChain chatModel from NocoBase's llmServices collection.
   * Follows the same pattern as AIEmployee.getLLMService().
   */
  private async resolveChatModel(aiManager: any, serviceName: string, purpose: string): Promise<any> {
    // Look up service in llmServices collection
    const service = await this.db.getRepository('llmServices').findOne({
      filter: { name: serviceName },
    });

    if (!service) {
      throw new ProviderError(
        `LLM service '${serviceName}' not found in llmServices. Configure it in the AI Settings.`,
        'nocobase-llm',
      );
    }

    // Get the provider class from aiManager's registry
    const providerMeta = aiManager.llmProviders.get(service.provider);
    if (!providerMeta) {
      throw new ProviderError(
        `LLM provider '${service.provider}' is not registered. Is the plugin installed?`,
        'nocobase-llm',
      );
    }

    // Create provider instance (same pattern as ai-employee.ts L262-L272)
    const Provider = providerMeta.provider;
    const provider = new Provider({
      app: this.app,
      serviceOptions: service.options,
      modelOptions: {
        llmService: serviceName,
        model: service.options?.defaultModel || service.options?.model,
      },
    });

    const chatModel = provider.chatModel || provider.createModel();
    if (!chatModel) {
      throw new ProviderError(`Failed to create chatModel for service '${serviceName}' (${purpose})`, 'nocobase-llm');
    }

    this.logger.info(
      `DocPixie: Resolved ${purpose} model from service '${serviceName}' (provider: ${service.provider})`,
    );
    return chatModel;
  }

  /** Create a no-op provider that throws clear errors */
  private createNoopProvider(): ILLMProvider {
    return {
      async processTextMessages() {
        throw new ProviderError('LLM provider not configured. Set llmServiceName in DocPixie settings.', 'none');
      },
      async processMultimodalMessages() {
        throw new ProviderError('LLM provider not configured. Set llmServiceName in DocPixie settings.', 'none');
      },
      getTotalCost() {
        return 0;
      },
      resetCost() {},
    };
  }

  /**
   * Extract pages from a document file.
   */
  private async extractPages(filePath: string, documentId: number): Promise<PageExtraction[]> {
    // Validate file exists
    if (!fs.existsSync(filePath)) {
      throw new ProcessingError(`File not found: ${filePath}`, filePath);
    }

    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      throw new ProcessingError(
        `Unsupported file type: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`,
        filePath,
      );
    }

    this.logger.info(`DocPixie: Processing file ${filePath} (ext=${ext})`);

    // Create storage directory for this document
    const storageDir = path.join(process.cwd(), 'storage', 'docpixie', String(documentId));
    fs.mkdirSync(storageDir, { recursive: true });

    // Copy file to storage
    const storedFileName = `original${ext}`;
    const storedFilePath = path.join(storageDir, storedFileName);
    fs.copyFileSync(filePath, storedFilePath);

    if (ext === '.pdf') {
      return this.extractPdfPages(storedFilePath, storageDir, documentId);
    } else {
      // Single image file = 1 page document
      return [
        {
          pageNumber: 1,
          structuredText: '',
          regions: [],
          imagePath: storedFilePath,
          hasTables: false,
          hasFigures: false,
          headings: [],
          extractionMethod: 'text_layer',
        },
      ];
    }
  }

  /**
   * Extract pages from a PDF file.
   */
  private async extractPdfPages(pdfPath: string, storageDir: string, documentId: number): Promise<PageExtraction[]> {
    const pages: PageExtraction[] = [];

    // Attempt OCR text extraction if provider is configured
    let ocrTexts: string[] = [];
    if (this.ocrProvider) {
      try {
        const available = await this.ocrProvider.isAvailable();
        if (available) {
          const text = await this.ocrProvider.extractText(pdfPath);
          ocrTexts = text.split(/\f|\n{4,}/).filter((t: string) => t.trim().length > 0);
        }
      } catch (err) {
        this.logger.warn('DocPixie: OCR extraction failed, continuing without text', err);
      }
    }

    const pageCount = Math.max(ocrTexts.length, 1);

    for (let i = 0; i < pageCount; i++) {
      pages.push({
        pageNumber: i + 1,
        structuredText: ocrTexts[i] || '',
        regions: [],
        imagePath: pdfPath,
        hasTables: false,
        hasFigures: false,
        headings: [],
        extractionMethod: ocrTexts[i] ? this.config!.ocrProvider : 'text_layer',
      });
    }

    this.logger.info(`DocPixie: PDF processed — ${pageCount} pages from ${pdfPath}`);
    return pages;
  }

  /**
   * Generate a summary for the entire document using LLM vision.
   */
  private async generateSummary(documentId: number, pages: PageExtraction[]): Promise<string> {
    if (!this.llmProvider) return 'Summary not available (LLM not configured)';

    // Collect all page image paths
    const imagePaths = pages.map((p) => p.imagePath).filter((p) => p && fs.existsSync(p));

    if (imagePaths.length > 0) {
      try {
        const content: any[] = [
          {
            type: 'text',
            text: `Please analyze this complete document and provide a comprehensive summary. Look at all pages together to understand the document's overall structure, main themes, key information, and purpose.`,
          },
        ];

        for (const imgPath of imagePaths) {
          content.push({
            type: 'image_path',
            image_path: imgPath,
            detail: 'low',
          });
        }

        return await this.llmProvider.processMultimodalMessages(
          [
            {
              role: 'system',
              content:
                'You are a document analysis expert. Analyze all pages of this document and create a comprehensive summary.',
            },
            { role: 'user', content },
          ],
          400,
          0.3,
        );
      } catch (err) {
        this.logger.warn('DocPixie: Vision summary failed, falling back to text', err);
      }
    }

    // Fallback: text-only summary
    const allText = pages.map((p) => p.structuredText).join('\n\n---\n\n');
    if (!allText.trim()) return 'Document processed (no text content extracted)';

    const truncated = allText.substring(0, 8000);
    return this.llmProvider.processTextMessages(
      [
        { role: 'system', content: SYSTEM_SUMMARIZER },
        { role: 'user', content: `Summarize this document concisely in 2-3 paragraphs:\n\n${truncated}` },
      ],
      500,
      0.3,
    );
  }

  // ═══════════════════════════════════════════
  // Context Processing (ported from context_processor.py)
  // ═══════════════════════════════════════════

  private async processConversationContext(
    history: Array<{ role: string; content: string }>,
    currentQuery: string,
  ): Promise<string> {
    const MAX_TURNS_BEFORE_SUMMARY = 8;
    const TURNS_TO_SUMMARIZE = 4;
    const TURNS_TO_KEEP_FULL = 4;

    const turns = history.filter((m) => m.role === 'user').length;

    if (turns <= MAX_TURNS_BEFORE_SUMMARY) {
      return history.map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`).join('\n\n');
    }

    this.logger.info(`DocPixie: Conversation has ${turns} turns, applying context summarization`);

    let turnCount = 0;
    let splitIndex = 0;
    for (let i = 0; i < history.length; i += 2) {
      if (i + 1 < history.length && history[i].role === 'user') {
        turnCount++;
        if (turnCount === TURNS_TO_SUMMARIZE) {
          splitIndex = i + 2;
          break;
        }
      }
    }

    const toSummarize = history.slice(0, splitIndex);
    let toKeep = history.slice(splitIndex);

    const maxKeep = TURNS_TO_KEEP_FULL * 2;
    if (toKeep.length > maxKeep) {
      toKeep = toKeep.slice(-maxKeep);
    }

    const conversationText = toSummarize
      .map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`)
      .join('\n\n');

    const summaryPrompt = fillPrompt(CONVERSATION_SUMMARIZATION_PROMPT, {
      conversation_text: conversationText,
    });

    const summary = await this.llmProvider!.processTextMessages(
      [
        { role: 'system', content: 'You are a helpful assistant that creates concise conversation summaries.' },
        { role: 'user', content: summaryPrompt },
      ],
      500,
      0.3,
    );

    const parts: string[] = [];
    parts.push(`Previous Conversation Summary:\n${summary.trim()}\n`);

    if (toKeep.length > 0) {
      parts.push('Recent Conversation:');
      parts.push(toKeep.map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`).join('\n\n'));
    }
    parts.push(`\nCurrent Query: ${currentQuery}`);

    return parts.join('\n');
  }

  // ═══════════════════════════════════════════
  // Query Reformulation
  // ═══════════════════════════════════════════

  private async reformulateQuery(query: string, history: Array<{ role: string; content: string }>): Promise<string> {
    try {
      const context = await this.processConversationContext(history, query);

      const prompt = fillPrompt(QUERY_REFORMULATION_PROMPT, {
        conversation_context: context,
        recent_topics: '',
        current_query: query,
      });

      const response = await this.llmProvider!.processTextMessages(
        [
          { role: 'system', content: SYSTEM_QUERY_REFORMULATOR },
          { role: 'user', content: prompt },
        ],
        8192,
        0.2,
      );

      const parsed = JSON.parse(this.sanitizeLlmJson(response));
      const reformulated = parsed.reformulated_query || query;
      this.logger.info(`DocPixie: Query reformulation: '${query}' → '${reformulated}'`);
      return reformulated;
    } catch (err: any) {
      this.logger.warn(`DocPixie: Reformulation failed, using original: ${err.message}`);
      return query;
    }
  }

  // ═══════════════════════════════════════════
  // Query Classification
  // ═══════════════════════════════════════════

  private async classifyQuery(query: string): Promise<boolean> {
    try {
      const prompt = fillPrompt(QUERY_CLASSIFICATION_PROMPT, { query });

      const response = await this.llmProvider!.processTextMessages(
        [
          { role: 'system', content: SYSTEM_QUERY_CLASSIFIER },
          { role: 'user', content: prompt },
        ],
        200,
        0.1,
      );

      const parsed = JSON.parse(this.sanitizeLlmJson(response));
      this.logger.info(`DocPixie: Query classification: ${parsed.reasoning}`);
      return parsed.needs_documents !== false;
    } catch (err: any) {
      this.logger.warn(`DocPixie: Classification failed, defaulting to needs_documents=true: ${err.message}`);
      return true;
    }
  }

  private async getDirectAnswer(query: string): Promise<string> {
    return this.llmProvider!.processTextMessages(
      [
        { role: 'system', content: SYSTEM_DIRECT_ANSWER },
        { role: 'user', content: query },
      ],
      500,
      0.3,
    );
  }

  // ═══════════════════════════════════════════
  // Adaptive Task Planning
  // ═══════════════════════════════════════════

  private async createInitialPlan(query: string, documents: any[]): Promise<TaskPlan> {
    const docTexts = documents
      .map((d: any) => {
        const id = d.get('id');
        const name = d.get('name');
        const summary = (d.get('summary') as string) || `Document with ${d.get('pageCount')} pages`;
        return `${id}: ${name}\nSummary: ${summary}`;
      })
      .join('\n\n');

    const prompt = fillPrompt(ADAPTIVE_INITIAL_PLANNING_PROMPT, {
      query,
      documents: docTexts,
    });

    const response = await this.llmProvider!.processTextMessages(
      [
        { role: 'system', content: SYSTEM_TASK_PLANNER },
        { role: 'user', content: prompt },
      ],
      8192,
      0.3,
    );

    try {
      const parsed = JSON.parse(this.sanitizeLlmJson(response));
      const rawTasks = (parsed.tasks || []).slice(0, this.config!.maxTasksPerPlan);

      const tasks = rawTasks.map((t: any) => {
        const docId = t.document || t.document_id;
        const doc = documents.find((d: any) => String(d.get('id')) === String(docId));
        return {
          name: t.name || 'Unnamed Task',
          description: t.description || '',
          documentId: doc ? (doc.get('id') as number) : documents[0]?.get('id'),
          documentName: doc ? (doc.get('name') as string) : documents[0]?.get('name') || 'Unknown',
        };
      });

      this.logger.info(`DocPixie: Initial plan created with ${tasks.length} tasks`);
      return createTaskPlan(query, tasks, this.config!.maxTasksPerPlan * 2);
    } catch {
      this.logger.warn('DocPixie: Failed to parse initial plan, using fallback');
      const fallbackTasks = documents.slice(0, 2).map((d: any) => ({
        name: `Analyze ${d.get('name')}`,
        description: query,
        documentId: d.get('id') as number,
        documentName: d.get('name') as string,
      }));
      return createTaskPlan(query, fallbackTasks, this.config!.maxTasksPerPlan * 2);
    }
  }

  /**
   * Execute tasks with adaptive replanning.
   * After each completed task, asks the LLM if the plan should be updated.
   */
  private async executeAdaptivePlan(
    taskPlan: TaskPlan,
    query: string,
    documents: any[],
    strategy: AnalysisStrategy,
    conversationHistory?: ConversationTurn[],
  ): Promise<{
    taskResults: TaskSummary[];
    allSourcePages: SourcePage[];
    analysisResults: string[];
  }> {
    const taskResults: TaskSummary[] = [];
    const allSourcePages: SourcePage[] = [];
    const analysisResults: string[] = [];
    let iteration = 0;

    while (taskPlan.hasPendingTasks() && iteration < taskPlan.maxIterations) {
      iteration++;
      this.logger.info(`DocPixie: Agent iteration ${iteration}`);

      const currentTask = taskPlan.getNextPendingTask();
      if (!currentTask) break;

      currentTask.status = 'in_progress';
      this.logger.info(`DocPixie: Executing task: ${currentTask.name}`);

      try {
        const { analysis, sourcePages } = await this.executeSingleTask(
          currentTask,
          query,
          strategy,
          conversationHistory,
        );

        currentTask.status = 'completed';
        analysisResults.push(analysis);
        allSourcePages.push(...sourcePages);
        taskResults.push({
          taskName: currentTask.name,
          documentName: currentTask.documentName,
          pagesAnalyzed: sourcePages.map((p) => p.pageNumber),
          status: 'completed',
        });

        this.logger.info(`DocPixie: Task completed: ${currentTask.name} (analyzed ${sourcePages.length} pages)`);

        // ── Adaptive Plan Update ──
        if (taskPlan.hasPendingTasks()) {
          this.logger.info('DocPixie: Checking if task plan needs updating...');
          const oldTaskCount = taskPlan.tasks.length;

          await this.updatePlanAdaptively(taskPlan, currentTask, analysis, query, documents);

          if (taskPlan.tasks.length !== oldTaskCount) {
            this.logger.info(`DocPixie: Plan updated — ${oldTaskCount} → ${taskPlan.tasks.length} tasks`);
          }
        }
      } catch (error) {
        currentTask.status = 'failed';
        this.logger.error(`DocPixie: Task failed — ${currentTask.name}`, error);
        taskResults.push({
          taskName: currentTask.name,
          documentName: currentTask.documentName,
          pagesAnalyzed: [],
          status: 'failed',
        });
      }
    }

    taskPlan.currentIteration = iteration;
    this.logger.info(`DocPixie: Adaptive execution completed after ${iteration} iterations`);
    return { taskResults, allSourcePages, analysisResults };
  }

  /**
   * Ask the LLM whether to continue/add/remove/modify tasks.
   */
  private async updatePlanAdaptively(
    plan: TaskPlan,
    completedTask: AgentTask,
    taskFindings: string,
    originalQuery: string,
    documents: any[],
  ): Promise<void> {
    const planStatus = plan.tasks.map((t) => `- [${t.id}] ${t.name}: ${t.status}`).join('\n');

    const completedTasks = plan.getCompletedTasks();
    const progressSummary =
      completedTasks.length === 1
        ? `Just completed first task: ${completedTask.name}`
        : 'Completed tasks:\n' + completedTasks.map((t) => `✓ ${t.name}`).join('\n');

    const docTexts = documents
      .map((d: any) => {
        const summary = (d.get('summary') as string) || `Document with ${d.get('pageCount')} pages`;
        return `${d.get('id')}: ${d.get('name')}\nSummary: ${summary}`;
      })
      .join('\n\n');

    const prompt = fillPrompt(ADAPTIVE_PLAN_UPDATE_PROMPT, {
      original_query: originalQuery,
      available_documents: docTexts,
      current_plan_status: planStatus,
      completed_task_name: completedTask.name,
      task_findings: taskFindings.substring(0, 2000),
      progress_summary: progressSummary,
    });

    const response = await this.llmProvider!.processTextMessages(
      [
        { role: 'system', content: SYSTEM_ADAPTIVE_PLANNER },
        { role: 'user', content: prompt },
      ],
      8192,
      0.3,
    );

    try {
      const updateData = JSON.parse(this.sanitizeLlmJson(response));
      const action = updateData.action || 'continue';
      const reason = updateData.reason || '';

      this.logger.info(`DocPixie: Plan update action: ${action} — ${reason}`);

      switch (action) {
        case 'continue':
          break;

        case 'add_tasks': {
          const newTasks = updateData.new_tasks || [];
          // Cap total task count to prevent runaway task creation
          const MAX_TOTAL_TASKS = plan.maxIterations * 2;
          for (const t of newTasks) {
            if (plan.tasks.length >= MAX_TOTAL_TASKS) {
              this.logger.warn(`DocPixie: Task limit reached (${MAX_TOTAL_TASKS}), ignoring further add_tasks`);
              break;
            }
            const docId = t.document || t.document_id;
            const doc = documents.find((d: any) => String(d.get('id')) === String(docId));
            plan.addTask({
              name: t.name || 'New Task',
              description: t.description || '',
              documentId: doc ? (doc.get('id') as number) : documents[0]?.get('id'),
              documentName: doc ? (doc.get('name') as string) : 'Unknown',
            });
            this.logger.info(`DocPixie: Added new task: ${t.name}`);
          }
          break;
        }

        case 'remove_tasks': {
          const toRemove = updateData.tasks_to_remove || [];
          for (const taskId of toRemove) {
            if (plan.removeTask(taskId)) {
              this.logger.info(`DocPixie: Removed task: ${taskId}`);
            }
          }
          break;
        }

        case 'modify_tasks': {
          const modifications = updateData.modified_tasks || [];
          for (const mod of modifications) {
            const task = plan.tasks.find((t) => t.id === mod.task_id && t.status === 'pending');
            if (task) {
              const oldName = task.name;
              task.name = mod.new_name || task.name;
              task.description = mod.new_description || task.description;
              if (mod.new_document) {
                const doc = documents.find((d: any) => String(d.get('id')) === String(mod.new_document));
                if (doc) {
                  task.documentId = doc.get('id') as number;
                  task.documentName = doc.get('name') as string;
                }
              }
              this.logger.info(`DocPixie: Modified task '${oldName}' → '${task.name}'`);
            }
          }
          break;
        }
      }
    } catch (err) {
      this.logger.warn('DocPixie: Failed to parse plan update response, continuing unchanged');
    }

    plan.currentIteration++;
  }

  /** Execute a single task: select pages → analyze. */
  private async executeSingleTask(
    task: AgentTask,
    query: string,
    strategy: AnalysisStrategy,
    conversationHistory?: ConversationTurn[],
  ): Promise<{ analysis: string; sourcePages: SourcePage[] }> {
    const selectedPageNumbers = await this.selectPages(
      task.documentId,
      task.description,
      strategy,
      this.config!.maxPagesPerTask,
    );

    const pageRepo = this.db.getRepository('docpixie_pages');
    const pages = await pageRepo.find({
      filter: {
        documentId: task.documentId,
        pageNumber: { $in: selectedPageNumbers },
      },
      sort: ['pageNumber'],
    });

    const analysis = await this.analyzePages(pages, task.description, strategy, conversationHistory);

    const sourcePages: SourcePage[] = selectedPageNumbers.map((pn) => ({
      documentId: task.documentId,
      documentName: task.documentName,
      pageNumber: pn,
    }));

    return { analysis, sourcePages };
  }

  // ═══════════════════════════════════════════
  // Response Synthesis
  // ═══════════════════════════════════════════

  private async synthesizeResponse(query: string, analyses: string[]): Promise<string> {
    if (analyses.length === 0) return 'No relevant information found in the documents.';
    if (analyses.length === 1) return analyses[0];

    const resultsText = analyses.map((a, i) => `--- Analysis ${i + 1} ---\n${a}`).join('\n\n');

    const prompt = fillPrompt(SYNTHESIS_PROMPT, {
      original_query: query,
      results_text: resultsText,
    });

    return this.llmProvider!.processTextMessages(
      [
        { role: 'system', content: SYSTEM_SYNTHESIS },
        { role: 'user', content: prompt },
      ],
      2000,
      0.3,
    );
  }

  /** Build memory summary from conversation history (last 4 messages). */
  private buildMemorySummary(history?: Array<{ role: string; content: string }>): string {
    if (!history || history.length === 0) {
      return 'CONVERSATION CONTEXT: This is the first query in the conversation.';
    }

    const recent = history.length > 4 ? history.slice(-4) : history;
    const parts = ['CONVERSATION CONTEXT:'];
    for (const msg of recent) {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      const content = msg.content.length > 100 ? msg.content.substring(0, 100) + '...' : msg.content;
      parts.push(`- ${role}: ${content}`);
    }
    return parts.join('\n');
  }

  private async loadQueryDocuments(documentIds?: number[]): Promise<any[]> {
    const repo = this.db.getRepository('docpixie_documents');
    const filter: any = { status: 'ready' };
    if (documentIds && documentIds.length > 0) {
      filter.id = { $in: documentIds };
      return repo.find({ filter });
    }
    return repo.find({ filter, limit: 10, sort: ['-createdAt'] });
  }

  private async loadQueryDocumentsByScope(options: {
    userId?: number;
    isAdmin?: boolean;
    documentIds?: number[];
  }): Promise<any[]> {
    const { userId, isAdmin, documentIds } = options;
    const repo = this.db.getRepository('docpixie_documents');
    const filter: any = { status: 'ready' };

    if (!isAdmin) {
      if (!userId) {
        return [];
      }
      filter.createdById = userId;
    }

    if (documentIds && documentIds.length > 0) {
      filter.id = { $in: documentIds };
      return repo.find({ filter });
    }

    return repo.find({ filter, limit: 10, sort: ['-createdAt'] });
  }

  private isAdminRole(roleNames?: string[]): boolean {
    if (!roleNames?.length) {
      return false;
    }
    const normalized = roleNames.map((name) => String(name).toLowerCase());
    return normalized.includes('admin') || normalized.includes('root');
  }

  private calculateConfidence(tasks: TaskSummary[]): number {
    if (tasks.length === 0) return 0;
    const completed = tasks.filter((t) => t.status === 'completed').length;
    return completed / tasks.length;
  }

  private parsePageSelection(response: string, maxPages: number): number[] {
    try {
      const cleaned = this.sanitizeLlmJson(response);
      const parsed = JSON.parse(cleaned);
      const pages = (parsed.selected_pages || []) as number[];
      return pages.slice(0, maxPages).sort((a, b) => a - b);
    } catch {
      this.logger.warn('DocPixie: Failed to parse page selection response');
      return [1]; // Fallback to first page
    }
  }

  /** Sanitize LLM JSON response: strip markdown fences, trailing commas. */
  private sanitizeLlmJson(text: string): string {
    let cleaned = text.trim();
    cleaned = cleaned
      .replace(/^```json?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
    return cleaned;
  }

  private extractFileName(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    const filename = parts[parts.length - 1];
    return filename.replace(/\.[^.]+$/, '');
  }

  /**
   * Create OCR provider adapter.
   * OCR is optional — when all processing is delegated to LLM vision,
   * this returns null (no OCR needed).
   */
  private createOCRProvider(config: DocPixiePluginConfig): IOCRProvider | null {
    if (config.ocrProvider === 'external_api' && config.ocrApiEndpoint) {
      return {
        name: 'external_api',
        async extractText(imagePath: string): Promise<string> {
          const buffer = fs.readFileSync(imagePath);
          const base64 = buffer.toString('base64');
          const ext = path.extname(imagePath).toLowerCase();
          const mime = MIME_TYPES[ext] || 'image/jpeg';

          const response = await fetch(config.ocrApiEndpoint!, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(config.ocrApiKey ? { Authorization: `Bearer ${config.ocrApiKey}` } : {}),
            },
            body: JSON.stringify({
              image: `data:${mime};base64,${base64}`,
            }),
          });

          if (!response.ok) {
            throw new ProviderError(`OCR API returned ${response.status}`, 'external_api');
          }

          const data = (await response.json()) as any;
          return data.text || data.result || '';
        },
        async extractStructured(imagePath: string): Promise<PageExtraction> {
          const text = await this.extractText(imagePath);
          return {
            pageNumber: 1,
            structuredText: text,
            regions: [],
            imagePath,
            hasTables: false,
            hasFigures: false,
            headings: [],
            extractionMethod: 'external_api',
          };
        },
        async isAvailable(): Promise<boolean> {
          try {
            const r = await fetch(config.ocrApiEndpoint!, { method: 'HEAD' });
            return r.ok || r.status === 405;
          } catch {
            return false;
          }
        },
      };
    }

    return null;
  }

  private createEmptyResult(query: string, startTime: number, reason: string): DocPixieQueryResult {
    return {
      answer: reason,
      sourcePages: [],
      confidence: 0,
      totalCost: 0,
      processingTime: (Date.now() - startTime) / 1000,
      tasksSummary: [],
    };
  }
}
