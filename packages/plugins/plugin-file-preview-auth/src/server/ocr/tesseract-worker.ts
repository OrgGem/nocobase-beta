import { TesseractRunner } from './tesseract-runner';
import path from 'path';

export class TesseractWorker {
  private app: any;
  private db: any;
  private log: any;
  private runner: TesseractRunner;
  private isRunning = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private redisKey = 'file-preview-auth.ocr.queue';

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

    // 1. Hãy thử kết nối với hàng đợi Redis nếu có
    const redis = await this.getRedisClient();
    if (redis) {
      this.log.info('[TesseractWorker] Redis queue is active. Waiting for push jobs.');
      this.listenRedisQueue(redis);
    } else {
      // 2. Chế độ Fallback: Polling Cơ sở dữ liệu định kỳ mỗi 5 giây
      this.log.info('[TesseractWorker] Redis is unavailable. Falling back to DB polling (every 5s).');
      this.startDbPolling();
    }
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
        return true;
      } catch (err: any) {
        this.log.warn(`[TesseractWorker] Redis push failed: ${err.message}. Falling back to DB state.`);
      }
    }
    // Fallback: Status is already pending-ocr in DB, DB Polling will automatically pick it up!
    return false;
  }

  private async getRedisClient(): Promise<any | null> {
    try {
      // NocoBase Redis Connection Manager
      const manager = (this.app as any).redisConnectionManager;
      if (manager && typeof manager.getConnection === 'function') {
        const client = await manager.getConnection('default');
        if (client) return client;
      }
    } catch {
      // Redis plugin not installed or inactive
    }
    return null;
  }

  private async listenRedisQueue(redis: any) {
    while (this.isRunning) {
      try {
        // BLPOP chặn để không tốn CPU (Chờ 5 giây)
        const result = await redis.sendCommand(['BLPOP', this.redisKey, '5']);
        if (result && Array.isArray(result) && result.length >= 2) {
          const attachmentId = parseInt(result[1], 10);
          if (Number.isFinite(attachmentId)) {
            await this.processJob(attachmentId);
          }
        }
      } catch (err: any) {
        // Tránh vòng lặp lỗi nhanh, chờ 3 giây nếu lỗi kết nối xảy ra
        this.log.error(`[TesseractWorker] Redis POP error: ${err.message}`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  private startDbPolling() {
    this.pollTimer = setInterval(async () => {
      if (!this.isRunning) return;
      try {
        const repo = this.db.getRepository('attachmentOcrResults');
        if (!repo) return;

        // Tìm 1 bản ghi duy nhất đang ở trạng thái pending-ocr để xử lý tuần tự
        const record = await repo.findOne({
          filter: { status: 'pending-ocr' },
          sort: ['createdAt'],
        });

        if (record) {
          const attachmentId = record.get('attachmentId');
          if (attachmentId != null) {
            await this.processJob(attachmentId);
          }
        }
      } catch (err: any) {
        this.log.error(`[TesseractWorker] DB Polling error: ${err.message}`);
      }
    }, 5000);
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
