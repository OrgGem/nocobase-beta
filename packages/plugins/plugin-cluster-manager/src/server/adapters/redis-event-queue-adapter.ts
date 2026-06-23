import type { Application, IEventQueueAdapter, QueueEventOptions, QueueMessageOptions } from '@nocobase/server';
import { createClient } from 'redis';
import { randomUUID } from 'crypto';
import { workerModeServesProcess } from '../../shared/worker-processes';

const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_ACK_TIMEOUT_MS = 15_000;
const REDIS_QUEUE_PREFIX = 'nocobase:event-queue';

type RedisClient = ReturnType<typeof createClient>;

type StoredMessage = {
  id: string;
  content: unknown;
  options?: QueueMessageOptions;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTimeoutSignal(timeout: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeout);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeout);
  return controller.signal;
}

export class RedisEventQueueAdapter implements IEventQueueAdapter {
  private client: RedisClient;
  private connected = false;
  private events = new Map<string, QueueEventOptions>();
  private reading = new Map<string, Set<Promise<void>>>();
  private consuming = new Set<string>();

  constructor(
    private readonly options: {
      app: Application;
      url: string;
    },
  ) {
    this.client = createClient({ url: options.url });
    this.client.on('error', (error) => {
      this.options.app.logger.error(`[RedisEventQueueAdapter] Redis error: ${error.message}`);
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.client.isOpen) {
      await this.client.connect();
    }
    this.connected = true;
    for (const channel of this.events.keys()) {
      this.startConsumer(channel);
    }
    this.options.app.logger.info('[RedisEventQueueAdapter] Connected');
  }

  async close(): Promise<void> {
    this.connected = false;
    const batches = Array.from(this.reading.values()).flatMap((items) => Array.from(items));
    if (batches.length) {
      await Promise.allSettled(batches);
    }
    if (this.client.isOpen) {
      await this.client.quit().catch(() => this.client.disconnect());
    }
    this.options.app.logger.info('[RedisEventQueueAdapter] Closed');
  }

  subscribe(channel: string, event: QueueEventOptions): void {
    this.events.set(channel, event);
    if (this.connected) {
      this.startConsumer(channel);
    }
  }

  unsubscribe(channel: string): void {
    this.events.delete(channel);
  }

  async publish(channel: string, content: unknown, options: QueueMessageOptions = {}): Promise<void> {
    if (!this.connected) {
      throw new Error('redis event queue is not connected');
    }
    const message: StoredMessage = {
      id: randomUUID(),
      content,
      options: {
        ...options,
        timestamp: Date.now(),
      },
    };
    await this.client.rPush(this.getQueueKey(channel), JSON.stringify(message));
  }

  private getQueueKey(channel: string) {
    return `${REDIS_QUEUE_PREFIX}:${channel}`;
  }

  private startConsumer(channel: string) {
    if (this.consuming.has(channel)) return;
    this.consuming.add(channel);
    return this.consume(channel)
      .catch((error) => {
        this.options.app.logger.error(`[RedisEventQueueAdapter] Consumer failed for ${channel}: ${error.message}`);
      })
      .finally(() => {
        this.consuming.delete(channel);
        if (this.connected && this.events.has(channel)) {
          this.startConsumer(channel);
        }
      });
  }

  private async consume(channel: string) {
    while (this.connected && this.events.has(channel)) {
      const event = this.events.get(channel);
      if (event && this.canProcess(channel, event)) {
        this.read(channel, event);
      }
      await sleep(event?.interval || DEFAULT_INTERVAL_MS);
    }
  }

  private canProcess(channel: string, event: QueueEventOptions) {
    if (!workerModeServesProcess(process.env.WORKER_MODE, channel)) {
      return false;
    }
    return event.idle();
  }

  private read(channel: string, event: QueueEventOptions) {
    const active = this.reading.get(channel) || new Set<Promise<void>>();
    this.reading.set(channel, active);

    const available = (event.concurrency || DEFAULT_CONCURRENCY) - active.size;
    for (let index = 0; index < available; index += 1) {
      const promise = this.readOne(channel, event).finally(() => active.delete(promise));
      active.add(promise);
    }
  }

  private async readOne(channel: string, event: QueueEventOptions) {
    const raw = await this.client.lPop(this.getQueueKey(channel));
    if (!raw) return;

    let message: StoredMessage;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      this.options.app.logger.warn(`[RedisEventQueueAdapter] Dropped invalid message from ${channel}`, error);
      return;
    }

    await this.process(channel, event, message);
  }

  private async process(channel: string, event: QueueEventOptions, message: StoredMessage) {
    const { timeout = DEFAULT_ACK_TIMEOUT_MS, maxRetries = 0, retried = 0 } = message.options || {};
    try {
      await event.process(message.content, {
        id: message.id,
        retried,
        signal: createTimeoutSignal(timeout),
        queueOptions: message.options,
      });
    } catch (error) {
      if (maxRetries > 0 && retried < maxRetries) {
        await this.publish(channel, message.content, {
          ...message.options,
          timeout,
          maxRetries,
          retried: retried + 1,
        });
        return;
      }
      this.options.app.logger.error(`[RedisEventQueueAdapter] Message failed on ${channel}`, error);
    }
  }
}
