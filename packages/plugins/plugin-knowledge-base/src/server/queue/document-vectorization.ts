import type { Application } from '@nocobase/server';
import type PluginKnowledgeBaseServer from '../plugin';

export const KB_DOCUMENT_VECTORIZE_QUEUE = 'knowledge-base:document-vectorize';
const KB_DOCUMENT_VECTORIZE_WORKER_ALIASES = [KB_DOCUMENT_VECTORIZE_QUEUE];

export type KnowledgeBaseDocumentQueueMessage = {
  documentId: string;
  reason: string;
  requestedById?: number | string | null;
};

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DOCUMENT_LOCK_TTL_MS = 60 * 60 * 1000;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isKnowledgeBaseDocumentWorker(app: Application): boolean {
  return app.serving(KB_DOCUMENT_VECTORIZE_QUEUE) || workerModeServesKnowledgeBaseDocument();
}

function workerModeServesKnowledgeBaseDocument(): boolean {
  const workerMode = process.env.WORKER_MODE || '';
  const workerModes = workerMode
    .split(',')
    .map((mode) => mode.trim())
    .filter(Boolean);

  return workerModes.some((mode) => {
    if (mode === '*' || mode === 'worker' || mode === 'task' || mode === KB_DOCUMENT_VECTORIZE_QUEUE) {
      return true;
    }
    return KB_DOCUMENT_VECTORIZE_WORKER_ALIASES.includes(mode);
  });
}

async function withDocumentLock<T>(app: Application, documentId: string, fn: () => Promise<T>): Promise<T> {
  const lockManager = (app as any).lockManager;
  if (lockManager?.runExclusive) {
    return lockManager.runExclusive(`knowledge-base:document:${documentId}`, fn, DOCUMENT_LOCK_TTL_MS);
  }
  return fn();
}

async function processQueuedDocument(plugin: PluginKnowledgeBaseServer, message: KnowledgeBaseDocumentQueueMessage) {
  const documentId = message?.documentId;
  if (!documentId) {
    plugin.app.logger.warn('[KnowledgeBaseQueue] Missing documentId in queue message');
    return { skipped: true, reason: 'missing-document-id' };
  }

  return withDocumentLock(plugin.app, String(documentId), async () => {
    const docRepo = plugin.db.getRepository('aiKnowledgeBaseDocuments');
    const doc = await docRepo.findOne({ filter: { id: documentId } });
    if (!doc) {
      plugin.app.logger.warn(`[KnowledgeBaseQueue] Document "${documentId}" not found; skipping`);
      return { skipped: true, reason: 'not-found' };
    }

    const status = doc.get?.('status') ?? doc.status;
    if (status === 'success') {
      return { skipped: true, reason: 'already-successful' };
    }

    const result = await plugin.vectorizationPipeline.processDocument(String(documentId));
    if (!result.success) {
      throw new Error(result.error || `Document "${documentId}" vectorization failed`);
    }

    return result;
  });
}

export async function enqueueKnowledgeBaseDocument(
  plugin: PluginKnowledgeBaseServer,
  message: KnowledgeBaseDocumentQueueMessage,
) {
  const timeout = parsePositiveInt(process.env.KB_DOCUMENT_WORKER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  await plugin.app.eventQueue.publish(KB_DOCUMENT_VECTORIZE_QUEUE, message, {
    timeout,
    maxRetries: 0,
  });
}

export function registerKnowledgeBaseDocumentQueue(plugin: PluginKnowledgeBaseServer) {
  const concurrency = parsePositiveInt(process.env.KB_DOCUMENT_WORKER_CONCURRENCY, DEFAULT_CONCURRENCY);
  plugin.app.eventQueue.subscribe(KB_DOCUMENT_VECTORIZE_QUEUE, {
    concurrency,
    idle: () => isKnowledgeBaseDocumentWorker(plugin.app),
    process: async (message: KnowledgeBaseDocumentQueueMessage) => {
      await processQueuedDocument(plugin, message);
    },
  });
}

export function unregisterKnowledgeBaseDocumentQueue(app: Application) {
  app.eventQueue.unsubscribe(KB_DOCUMENT_VECTORIZE_QUEUE);
}
