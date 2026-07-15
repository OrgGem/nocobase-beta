import type { Application, IEventQueueAdapter, QueueEventOptions, QueueMessageOptions } from '@nocobase/server';
import { createClient } from 'redis';
import { randomUUID } from 'crypto';
import { workerModeServesProcess } from '../../shared/worker-processes';
import { getLocalNodeId } from '../utils/node';

const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_ACK_TIMEOUT_MS = 15_000;
const DEFAULT_VISIBILITY_TIMEOUT_MS = 60_000;
const READ_BLOCK_MS = 1_000;
const REDIS_QUEUE_PREFIX = 'nocobase:event-queue';
const CONSUMER_GROUP = 'nocobase-workers';

type RedisClient = ReturnType<typeof createClient>;

type StoredMessage = {
  id: string;
  content: unknown;
  options?: QueueMessageOptions;
};

type StreamEntry = {
  streamId: string;
  message: StoredMessage;
  malformed?: boolean;
};

function createTimeoutSignal(timeout: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeout);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  timer.unref?.();
  return controller.signal;
}

export class RedisEventQueueAdapter implements IEventQueueAdapter {
  private readonly client: RedisClient;
  private readonly events = new Map<string, QueueEventOptions>();
  private readonly consuming = new Map<string, Promise<void>>();
  private readonly processing = new Map<string, Set<Promise<void>>>();
  private readonly initializedStreams = new Set<string>();
  private readonly consumerName: string;
  private connected = false;

  constructor(
    private readonly options: {
      app: Application;
      url: string;
      visibilityTimeoutMs?: number;
    },
  ) {
    this.client = createClient({ url: options.url });
    this.consumerName = getLocalNodeId(options.app);
    this.client.on('error', (error) => {
      this.options.app.logger.error(`[RedisEventQueueAdapter] Redis error: ${error.message}`);
    });
  }

  isConnected(): boolean {
    return this.connected && this.client.isReady;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.client.isOpen) await this.client.connect();
    this.connected = true;
    for (const channel of this.events.keys()) this.startConsumer(channel);
    this.options.app.logger.info(`[RedisEventQueueAdapter] Connected as ${this.consumerName}`);
  }

  async close(): Promise<void> {
    this.connected = false;
    await Promise.allSettled(Array.from(this.consuming.values()));
    const processing = Array.from(this.processing.values()).flatMap((items) => Array.from(items));
    await Promise.allSettled(processing);
    if (this.client.isOpen) await this.client.quit().catch(() => this.client.destroy());
    this.options.app.logger.info('[RedisEventQueueAdapter] Closed');
  }

  subscribe(channel: string, event: QueueEventOptions): void {
    this.events.set(channel, event);
    if (this.connected) this.startConsumer(channel);
  }

  unsubscribe(channel: string): void {
    this.events.delete(channel);
  }

  async publish(channel: string, content: unknown, options: QueueMessageOptions = {}): Promise<void> {
    if (!this.isConnected()) throw new Error('redis event queue is not connected');
    const message: StoredMessage = {
      id: randomUUID(),
      content,
      options: { ...options, timestamp: Date.now() },
    };
    await this.ensureConsumerGroup(channel);
    await this.client.sendCommand(['XADD', this.getQueueKey(channel), '*', 'message', JSON.stringify(message)]);
  }

  private getQueueKey(channel: string): string {
    return `${REDIS_QUEUE_PREFIX}:${channel}`;
  }

  private getDeadLetterKey(channel: string): string {
    return `${this.getQueueKey(channel)}:dlq`;
  }

  private async ensureConsumerGroup(channel: string): Promise<void> {
    if (this.initializedStreams.has(channel)) return;
    try {
      await this.client.sendCommand(['XGROUP', 'CREATE', this.getQueueKey(channel), CONSUMER_GROUP, '0', 'MKSTREAM']);
    } catch (error: unknown) {
      if (!this.getErrorMessage(error).includes('BUSYGROUP')) throw error;
    }
    this.initializedStreams.add(channel);
  }

  private startConsumer(channel: string): void {
    if (this.consuming.has(channel)) return;
    const consumer = this.consume(channel)
      .catch((error: unknown) => {
        if (this.connected) {
          this.options.app.logger.error(
            `[RedisEventQueueAdapter] Consumer failed for ${channel}: ${this.getErrorMessage(error)}`,
          );
        }
      })
      .finally(() => {
        this.consuming.delete(channel);
        if (this.connected && this.events.has(channel)) this.startConsumer(channel);
      });
    this.consuming.set(channel, consumer);
  }

  private async consume(channel: string): Promise<void> {
    await this.ensureConsumerGroup(channel);
    while (this.connected && this.events.has(channel)) {
      const event = this.events.get(channel);
      if (!event || !this.canProcess(channel, event)) {
        await this.sleep(event?.interval || DEFAULT_INTERVAL_MS);
        continue;
      }

      const active = this.processing.get(channel) || new Set<Promise<void>>();
      this.processing.set(channel, active);
      const available = Math.max(0, (event.concurrency || DEFAULT_CONCURRENCY) - active.size);
      if (available === 0) {
        await this.sleep(event.interval || DEFAULT_INTERVAL_MS);
        continue;
      }

      const reclaimed = await this.claimStale(channel, available);
      const entries = reclaimed.length ? reclaimed : await this.readNew(channel, available);
      if (entries.length === 0) {
        await this.sleep(event.interval || DEFAULT_INTERVAL_MS);
        continue;
      }
      for (const entry of entries) {
        const task = this.processEntry(channel, event, entry).finally(() => active.delete(task));
        active.add(task);
      }
    }
  }

  private canProcess(channel: string, event: QueueEventOptions): boolean {
    return workerModeServesProcess(process.env.WORKER_MODE, channel) && event.idle();
  }

  private async readNew(channel: string, count: number): Promise<StreamEntry[]> {
    const response = await this.client.sendCommand([
      'XREADGROUP',
      'GROUP',
      CONSUMER_GROUP,
      this.consumerName,
      'COUNT',
      String(count),
      'BLOCK',
      String(READ_BLOCK_MS),
      'STREAMS',
      this.getQueueKey(channel),
      '>',
    ]);
    return this.parseReadResponse(response);
  }

  private async claimStale(channel: string, count: number): Promise<StreamEntry[]> {
    const response = await this.client.sendCommand([
      'XAUTOCLAIM',
      this.getQueueKey(channel),
      CONSUMER_GROUP,
      this.consumerName,
      String(this.options.visibilityTimeoutMs || DEFAULT_VISIBILITY_TIMEOUT_MS),
      '0-0',
      'COUNT',
      String(count),
    ]);
    if (!Array.isArray(response) || !Array.isArray(response[1])) return [];
    return this.parseEntries(response[1]);
  }

  private parseReadResponse(response: unknown): StreamEntry[] {
    if (!Array.isArray(response) || response.length === 0) return [];
    const stream = response[0];
    if (!Array.isArray(stream) || !Array.isArray(stream[1])) return [];
    return this.parseEntries(stream[1]);
  }

  private parseEntries(entries: unknown[]): StreamEntry[] {
    const result: StreamEntry[] = [];
    for (const rawEntry of entries) {
      if (!Array.isArray(rawEntry) || typeof rawEntry[0] !== 'string' || !Array.isArray(rawEntry[1])) continue;
      const fields = rawEntry[1];
      const messageIndex = fields.findIndex((field) => field === 'message');
      const rawMessage = messageIndex >= 0 ? fields[messageIndex + 1] : undefined;
      if (typeof rawMessage !== 'string') continue;
      try {
        result.push({ streamId: rawEntry[0], message: JSON.parse(rawMessage) as StoredMessage });
      } catch {
        result.push({
          streamId: rawEntry[0],
          message: { id: randomUUID(), content: rawMessage, options: { maxRetries: 0 } },
          malformed: true,
        });
      }
    }
    return result;
  }

  private async processEntry(channel: string, event: QueueEventOptions, entry: StreamEntry): Promise<void> {
    if (entry.malformed) {
      await this.moveToDeadLetter(channel, entry, new Error('Invalid queue message JSON'));
      await this.ack(channel, entry.streamId);
      return;
    }
    const { timeout = DEFAULT_ACK_TIMEOUT_MS, maxRetries = 0, retried = 0 } = entry.message.options || {};
    const heartbeatInterval = Math.max(
      1_000,
      Math.floor((this.options.visibilityTimeoutMs || DEFAULT_VISIBILITY_TIMEOUT_MS) / 3),
    );
    const heartbeat = setInterval(() => {
      this.refreshPendingLease(channel, entry.streamId).catch((error: unknown) => {
        this.options.app.logger.warn(
          `[RedisEventQueueAdapter] Failed to refresh pending message ${entry.streamId}: ${this.getErrorMessage(
            error,
          )}`,
        );
      });
    }, heartbeatInterval);
    heartbeat.unref?.();
    try {
      await event.process(entry.message.content, {
        id: entry.message.id,
        retried,
        signal: createTimeoutSignal(timeout),
        queueOptions: entry.message.options,
      });
      await this.ack(channel, entry.streamId);
    } catch (error: unknown) {
      if (retried < maxRetries) {
        await this.publish(channel, entry.message.content, {
          ...entry.message.options,
          timeout,
          maxRetries,
          retried: retried + 1,
        });
      } else {
        await this.moveToDeadLetter(channel, entry, error);
      }
      await this.ack(channel, entry.streamId);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async refreshPendingLease(channel: string, streamId: string): Promise<void> {
    await this.client.sendCommand([
      'XCLAIM',
      this.getQueueKey(channel),
      CONSUMER_GROUP,
      this.consumerName,
      '0',
      streamId,
      'JUSTID',
    ]);
  }

  private async ack(channel: string, streamId: string): Promise<void> {
    await this.client.sendCommand(['XACK', this.getQueueKey(channel), CONSUMER_GROUP, streamId]);
    await this.client.sendCommand(['XDEL', this.getQueueKey(channel), streamId]);
  }

  private async moveToDeadLetter(channel: string, entry: StreamEntry, error: unknown): Promise<void> {
    await this.client.sendCommand([
      'XADD',
      this.getDeadLetterKey(channel),
      '*',
      'message',
      JSON.stringify(entry.message),
      'sourceStreamId',
      entry.streamId,
      'error',
      this.getErrorMessage(error),
      'failedAt',
      String(Date.now()),
    ]);
    this.options.app.logger.error(
      `[RedisEventQueueAdapter] Message ${entry.message.id} moved to DLQ for ${channel}: ${this.getErrorMessage(
        error,
      )}`,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
