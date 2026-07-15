import { createClient } from 'redis';
import { IPubSubAdapter, PubSubCallback } from '@nocobase/server';

export class RedisPubSubAdapter implements IPubSubAdapter {
  private publisher: ReturnType<typeof createClient>;
  private subscriber: ReturnType<typeof createClient>;
  private connected = false;
  // Map of channel to set of callbacks
  private subscriptions = new Map<string, Set<PubSubCallback>>();

  constructor(
    private url: string,
    private logger?: any,
  ) {
    this.publisher = createClient({ url: this.url });
    this.subscriber = createClient({ url: this.url });

    this.publisher.on('error', (err) => {
      this.logger?.error(`[RedisPubSubAdapter] Publisher error: ${err.message}`);
    });
    this.subscriber.on('error', (err) => {
      this.logger?.error(`[RedisPubSubAdapter] Subscriber error: ${err.message}`);
    });
  }

  isConnected() {
    return this.connected && this.publisher.isReady && this.subscriber.isReady;
  }

  async connect() {
    if (this.connected) return;

    try {
      await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
      this.connected = true;
      this.logger?.info('[RedisPubSubAdapter] Successfully connected to Redis PubSub');
    } catch (error: any) {
      this.connected = false;
      this.logger?.error(`[RedisPubSubAdapter] Connection failed: ${error.message}`);
      throw error;
    }
  }

  async close() {
    this.connected = false;
    await Promise.allSettled([
      this.subscriber.quit().catch(() => this.subscriber.destroy()),
      this.publisher.quit().catch(() => this.publisher.destroy()),
    ]);
    this.logger?.info('[RedisPubSubAdapter] Connection closed');
  }

  async subscribe(channel: string, callback: PubSubCallback) {
    let callbacks = this.subscriptions.get(channel);

    if (!callbacks) {
      callbacks = new Set<PubSubCallback>();
      this.subscriptions.set(channel, callbacks);

      // First subscriber to this channel, so register with Redis
      try {
        await this.subscriber.subscribe(channel, (message, ch) => {
          // Dispatch to all registered callbacks
          const cbs = this.subscriptions.get(ch);
          if (cbs) {
            Array.from(cbs).forEach((cb) => {
              try {
                cb(message);
              } catch (err: any) {
                this.logger?.error(`[RedisPubSubAdapter] Callback error on channel ${ch}: ${err.message}`);
              }
            });
          }
        });
      } catch (err: any) {
        this.logger?.error(`[RedisPubSubAdapter] Subscribe error on channel ${channel}: ${err.message}`);
        this.subscriptions.delete(channel);
        throw err;
      }
    }

    callbacks.add(callback);
  }

  async unsubscribe(channel: string, callback: PubSubCallback) {
    const callbacks = this.subscriptions.get(channel);
    if (!callbacks) return;

    callbacks.delete(callback);

    // If no more callbacks listen to this channel, unsubscribe from Redis
    if (callbacks.size === 0) {
      this.subscriptions.delete(channel);
      try {
        await this.subscriber.unsubscribe(channel);
      } catch (err: any) {
        this.logger?.error(`[RedisPubSubAdapter] Unsubscribe error on channel ${channel}: ${err.message}`);
        throw err;
      }
    }
  }

  async publish(channel: string, message: string) {
    if (!this.isConnected()) throw new Error('Redis PubSub adapter is not connected');
    try {
      await this.publisher.publish(channel, message);
    } catch (err: any) {
      this.logger?.error(`[RedisPubSubAdapter] Publish error on channel ${channel}: ${err.message}`);
      throw err;
    }
  }
}
