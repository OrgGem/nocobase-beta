import { TesseractRunner } from './tesseract-runner';
import path from 'path';

export const WORKER_JOB_FILE_PREVIEW_OCR_PROCESS = 'file-preview-auth:ocr';
export const FILE_PREVIEW_OCR_QUEUE_REDIS_KEY = 'file-preview-auth.ocr.queue';
const FILE_PREVIEW_OCR_QUEUE_REDIS_CONNECTION = 'plugin-file-preview-auth.ocr.queue';
const FILE_PREVIEW_OCR_QUEUE_POLL_INTERVAL_MS = Math.max(
  1000,
  Number.parseInt(process.env.FILE_PREVIEW_OCR_QUEUE_POLL_INTERVAL_MS || '', 10) || 5000,
);
const FILE_PREVIEW_OCR_QUEUE_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.FILE_PREVIEW_OCR_QUEUE_CONCURRENCY || '', 10) || 1,
);
const FILE_PREVIEW_OCR_PROCESS_LOCK_TTL_MS = Math.max(
  60_000,
  Number.parseInt(process.env.FILE_PREVIEW_OCR_PROCESS_LOCK_TTL_MS || '', 10) || 10 * 60 * 1000,
);

interface RedisLikeConnection {
  sendCommand(command: string[]): Promise<unknown>;
}

interface RedisConnectionManagerLike {
  getConnectionSync?: (
    name: string,
    options?: { connectionString?: string },
  ) => Promise<RedisLikeConnection> | RedisLikeConnection;
  getConnection?: (
    name?: string,
    options?: { connectionString?: string },
  ) => Promise<RedisLikeConnection> | RedisLikeConnection;
}

interface LockManagerLike {
  runExclusive<T>(key: string, fn: () => Promise<T>, ttl?: number): Promise<T>;
}

export class TesseractWorker {
  private app: any;
  private db: any;
  private log: any;
  private runner: TesseractRunner;
  private isRunning = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private kickTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private redisKey = FILE_PREVIEW_OCR_QUEUE_REDIS_KEY;

  constructor(app: any) {
    this.app = app;
    this.db = app.db;
    this.log = app.log || console;
    this.runner = new TesseractRunner(app);
  }

  /**
   * Start the background worker.
   */
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.log.info('[TesseractWorker] OCR background worker started.');
    this.startQueueProcessor();
  }

  /**
   * Stop the background worker.
   */
  stop() {
    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.kickTimer) {
      clearTimeout(this.kickTimer);
      this.kickTimer = null;
    }
    this.isProcessing = false;
    this.log.info('[TesseractWorker] OCR background worker stopped.');
  }

  /**
   * Enqueue a new OCR job.
   */
  async enqueue(attachmentId: number | string) {
    const redis = await this.getRedisClient();
    if (redis) {
      try {
        await redis.sendCommand(['RPUSH', this.redisKey, String(attachmentId)]);
        this.log.debug(`[TesseractWorker] Enqueued attachment ${attachmentId} to Redis`);
        this.scheduleQueueTick(0);
        return true;
      } catch (err: unknown) {
        this.log.warn(
          `[TesseractWorker] Redis push failed: ${getErrorMessage(err)}. Falling back to DB pending queue.`,
        );
      }
    }
    this.scheduleQueueTick(0);
    return false;
  }

  private async getRedisClient(): Promise<RedisLikeConnection | null> {
    try {
      const manager = (this.app as { redisConnectionManager?: RedisConnectionManagerLike }).redisConnectionManager;
      const connectionString = process.env.QUEUE_ADAPTER_REDIS_URL || process.env.REDIS_URL;
      if (manager?.getConnectionSync) {
        const client = await manager.getConnectionSync(
          FILE_PREVIEW_OCR_QUEUE_REDIS_CONNECTION,
          connectionString ? { connectionString } : undefined,
        );
        if (client) return client;
      }
      if (manager?.getConnection) {
        const client = await manager.getConnection(
          FILE_PREVIEW_OCR_QUEUE_REDIS_CONNECTION,
          connectionString ? { connectionString } : undefined,
        );
        if (client) return client;
      }
    } catch (err: unknown) {
      this.log.debug?.(
        `[TesseractWorker] Redis queue unavailable; DB polling fallback active: ${getErrorMessage(err)}`,
      );
    }
    return null;
  }

  private startQueueProcessor() {
    if (this.pollTimer) return;
    this.log.info(
      `[TesseractWorker] OCR queue processor started (interval ${FILE_PREVIEW_OCR_QUEUE_POLL_INTERVAL_MS}ms).`,
    );
    this.pollTimer = setInterval(() => this.scheduleQueueTick(0), FILE_PREVIEW_OCR_QUEUE_POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
    this.scheduleQueueTick(1000);
  }

  private scheduleQueueTick(delayMs: number) {
    if (!this.isRunning || this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      this.runQueueTick().catch((err: unknown) =>
        this.log.error(`[TesseractWorker] OCR queue processor tick failed: ${getErrorMessage(err)}`),
      );
    }, delayMs);
    this.kickTimer.unref?.();
  }

  private async runQueueTick() {
    if (this.isProcessing || !this.isRunning) return;

    this.isProcessing = true;
    try {
      const redisJobs = await this.drainRedisQueue(FILE_PREVIEW_OCR_QUEUE_CONCURRENCY);
      await this.processAttachmentIds(redisJobs);

      const remaining = Math.max(1, FILE_PREVIEW_OCR_QUEUE_CONCURRENCY - redisJobs.length);
      await this.processPendingDbJobs(remaining);
    } finally {
      this.isProcessing = false;
    }
  }

  private async drainRedisQueue(count: number): Promise<Array<number | string>> {
    const redis = await this.getRedisClient();
    if (!redis) return [];

    const attachmentIds: Array<number | string> = [];
    try {
      for (let i = 0; i < count; i += 1) {
        const raw = await redis.sendCommand(['LPOP', this.redisKey]);
        if (!raw) break;
        const attachmentId = parseAttachmentId(raw);
        if (attachmentId === null) {
          this.log.warn(`[TesseractWorker] Dropped invalid Redis OCR message: ${String(raw)}`);
          continue;
        }
        attachmentIds.push(attachmentId);
      }
    } catch (err: unknown) {
      this.log.debug?.(
        `[TesseractWorker] Redis queue drain failed; DB polling fallback active: ${getErrorMessage(err)}`,
      );
    }
    return attachmentIds;
  }

  private async processPendingDbJobs(count: number) {
    try {
      const repo = this.db.getRepository('attachmentOcrResults');
      if (!repo) return;

      const records = await repo.find({
        filter: { status: 'pending-ocr' },
        sort: ['createdAt'],
        limit: count,
      });

      const attachmentIds: Array<number | string> = [];
      for (const record of records || []) {
        const attachmentId = record.get('attachmentId');
        if (attachmentId != null) {
          attachmentIds.push(attachmentId);
        }
      }

      await this.processAttachmentIds(attachmentIds);
    } catch (err: unknown) {
      this.log.error(`[TesseractWorker] DB polling error: ${getErrorMessage(err)}`);
    }
  }

  private async processAttachmentIds(attachmentIds: Array<number | string>) {
    for (const attachmentId of attachmentIds) {
      await this.processJobWithLock(attachmentId);
    }
  }

  private async processJobWithLock(attachmentId: number | string) {
    const lockManager = (this.app as { lockManager?: LockManagerLike }).lockManager;
    const lockKey = `file-preview-auth:ocr:process:${attachmentId}`;
    if (lockManager?.runExclusive) {
      await lockManager.runExclusive(
        lockKey,
        () => this.processJob(attachmentId),
        FILE_PREVIEW_OCR_PROCESS_LOCK_TTL_MS,
      );
      return;
    }
    await this.processJob(attachmentId);
  }

  private async processJob(attachmentId: number | string) {
    this.log.info(`[TesseractWorker] Processing OCR Job for attachment ID ${attachmentId}`);
    const repo = this.db.getRepository('attachments');
    const ocrRepo = this.db.getRepository('attachmentOcrResults');
    if (!repo || !ocrRepo) return;

    const attachment = await repo.findOne({ filterByTk: attachmentId });
    if (!attachment) {
      this.log.warn(`[TesseractWorker] Attachment ${attachmentId} not found in DB.`);
      await this.updateOcrResult(attachmentId, {
        status: 'failed',
        error: 'Attachment not found',
      }).catch(() => {});
      return;
    }

    try {
      const ocrRecord = await ocrRepo.findOne({ filter: { attachmentId } });
      if (ocrRecord && ocrRecord.get('status') !== 'pending-ocr') {
        this.log.debug?.(
          `[TesseractWorker] Attachment ${attachmentId} OCR status is ${ocrRecord.get('status')}, skipping stale job.`,
        );
        return;
      }

      // Lấy đường dẫn file vật lý trên server (NocoBase lưu trữ)
      const fileManager = this.app.pm.get('@nocobase/plugin-file-manager') as any;
      if (!fileManager) {
        throw new Error('File manager plugin is not active.');
      }

      // Lấy file path tuyệt đối
      const storageModel = getStorageFromCache(fileManager.storagesCache, attachment.storageId);
      if (!storageModel || storageModel.type !== 'local') {
        // Hỗ trợ local storage trước. Nếu là S3, runner sẽ tự động lấy stream từ fileManager.
        this.log.info(`[TesseractWorker] Non-local storage detected or virtual file. Using fallback.`);
      }

      const filePath = path.resolve(process.cwd(), attachment.path || '');

      // Chạy Tesseract trích xuất văn bản cấp độ từ
      const result = await this.runner.runOcr(filePath, attachmentId);

      // Cấu trúc dữ liệu JSON để lưu trữ (pages: [...])
      const ocrData = {
        pages: result.pages,
      };

      // Cập nhật kết quả vào DB
      await this.updateOcrResult(attachmentId, {
        data: ocrData,
        status: 'waiting-verify',
        error: null,
      });

      this.log.info(`[TesseractWorker] Successfully processed OCR for attachment ${attachmentId}`);
    } catch (err: any) {
      this.log.error(
        `[TesseractWorker] Failed to process OCR for attachment ${attachmentId}: ${err.stack || err.message}`,
      );

      // Chuyển trạng thái sang 'no-ocr' để người dùng có thể chạy lại
      await this.updateOcrResult(attachmentId, {
        status: 'failed',
        error: err?.message || String(err),
      }).catch(() => {});
    }
  }

  private async updateOcrResult(attachmentId: number | string, values: Record<string, any>) {
    const repo = this.db.getRepository('attachmentOcrResults');
    if (!repo) return null;

    const existing = await repo.findOne({
      filter: {
        attachmentId,
      },
    });
    const nextValues = {
      attachmentId,
      ...values,
    };

    if (existing) {
      await repo.update({
        filterByTk: existing.get('id'),
        values: nextValues,
      });
      return existing;
    }

    return repo.create({
      values: nextValues,
    });
  }
}

function getStorageFromCache(cache: Map<any, any>, storageId: any) {
  if (storageId === undefined || storageId === null) return undefined;
  let res = cache.get(storageId);
  if (res) return res;
  const strId = String(storageId);
  res = cache.get(strId);
  if (res) return res;
  const numId = Number(storageId);
  if (!isNaN(numId)) {
    res = cache.get(numId);
    if (res) return res;
  }
  for (const [k, v] of cache.entries()) {
    if (String(k) === strId) {
      return v;
    }
  }
  return undefined;
}

function parseAttachmentId(value: unknown): number | string | null {
  const text = String(value);
  const numeric = Number.parseInt(text, 10);
  if (Number.isFinite(numeric) && String(numeric) === text) {
    return numeric;
  }
  return text ? text : null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
