import type { Application } from '@nocobase/server';
import { DocumentIndexer } from './services/document-indexer';
import { getWorkerId, workerModeServesFileSearch } from './services/file-utils';

const POLL_INTERVAL_MS = Math.max(1000, Number.parseInt(process.env.FILE_SEARCH_QUEUE_POLL_MS || '5000', 10));

let timer: NodeJS.Timeout | null = null;
let running = false;

function createWorkerContext(app: any) {
  const headers: Record<string, string> = { 'x-timezone': '+00:00', 'x-locale': 'en-US' };
  return {
    app,
    db: app.db,
    log: app.log || app.logger || console,
    logger: app.logger || app.log || console,
    state: {},
    auth: {},
    req: { headers },
    request: { headers },
    get(name: string) {
      return headers[String(name).toLowerCase()] || '';
    },
    throw(status: number, message: string) {
      const error = new Error(message) as Error & { status?: number };
      error.status = status;
      throw error;
    },
  } as any;
}

export function startFileSearchQueue(app: Application) {
  if (timer || !workerModeServesFileSearch()) {
    app.log?.debug?.('[plugin-file-search] Queue processor not started on this node');
    return;
  }
  app.log?.info?.(`[plugin-file-search] Queue processor started (${POLL_INTERVAL_MS}ms)`);
  timer = setInterval(
    () => processOne(app).catch((error) => app.log?.error?.('[plugin-file-search] queue tick failed', error)),
    POLL_INTERVAL_MS,
  );
}

export function stopFileSearchQueue() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export function getFileSearchQueueStatus() {
  return {
    running: Boolean(timer),
    processing: running,
    workerId: getWorkerId(),
    intervalMs: POLL_INTERVAL_MS,
    workerMode: process.env.WORKER_MODE || null,
  };
}

async function processOne(app: any) {
  if (running) return;
  running = true;
  try {
    const jobRepo = app.db.getRepository('fileSearchJobs');
    const job = await jobRepo.findOne({
      filter: { status: 'queued' },
      sort: ['-priority', 'queuedAt'],
    });
    if (!job) return;

    const jobId = job.get('id');
    const workerId = getWorkerId();
    await jobRepo.update({
      filter: { id: jobId, status: 'queued' },
      values: {
        status: 'running',
        startedAt: new Date(),
        workerId,
        attempts: Number(job.get('attempts') || 0) + 1,
        errorMessage: null,
      },
    });
    const claimedJob = await jobRepo.findOne({ filter: { id: jobId, status: 'running', workerId } });
    if (!claimedJob) return;

    const ctx = createWorkerContext(app);
    const indexer = new DocumentIndexer(app);
    try {
      await indexer.indexDocument(ctx, claimedJob.get('documentId'));
      await jobRepo.update({
        filterByTk: jobId,
        values: { status: 'succeeded', finishedAt: new Date(), errorMessage: null },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await app.db.getRepository('fileSearchDocuments').update({
        filterByTk: claimedJob.get('documentId'),
        values: { status: 'failed', errorMessage: message },
      });
      await jobRepo.update({
        filterByTk: jobId,
        values: { status: 'failed', finishedAt: new Date(), errorMessage: message },
      });
    }
  } finally {
    running = false;
  }
}
