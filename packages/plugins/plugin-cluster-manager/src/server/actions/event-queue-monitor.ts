import { Context } from '@nocobase/actions';

export const eventQueueActions = {
  /**
   * GET /clusterManagerQueue:stats
   * Returns event queue statistics
   */
  async stats(ctx: Context, next: () => Promise<void>) {
    const eq = ctx.app.eventQueue;
    if (!eq) {
      ctx.throw(503, 'Event queue is not available');
    }

    const adapter = (eq as any).adapter;
    const events = (eq as any).events as Map<string, any>;
    const adapterName = adapter?.constructor?.name || 'unknown';
    const connected = eq.isConnected();

    const channels: any[] = [];
    if (events) {
      for (const [channel, opts] of events.entries()) {
        const queueData: any = { channel };
        queueData.concurrency = opts.concurrency || 1;
        queueData.interval = opts.interval || 250;

        // For MemoryEventQueueAdapter, we can peek at queue depth
        if (adapter?.queues) {
          const fullChannel = eq.getFullChannel(channel, opts.shared);
          const queue = adapter.queues.get(fullChannel);
          queueData.pending = queue?.length || 0;
        } else {
          queueData.pending = null; // Unknown for external adapters
        }

        channels.push(queueData);
      }
    }

    const totalPending = channels.reduce((sum, c) => sum + (c.pending || 0), 0);

    ctx.body = {
      adapter: adapterName,
      connected,
      totalChannels: channels.length,
      totalPending,
      channels,
    };
    await next();
  },

  /**
   * GET /clusterManagerQueue:messages
   * List pending messages in a specific channel (memory adapter only)
   */
  async messages(ctx: Context, next: () => Promise<void>) {
    const eq = ctx.app.eventQueue;
    if (!eq) {
      ctx.throw(503, 'Event queue is not available');
    }

    const { channel, page = 1, pageSize = 20 } = ctx.action.params;
    const adapter = (eq as any).adapter;

    if (!adapter?.queues) {
      ctx.body = {
        data: [],
        meta: { count: 0, page: 1, pageSize: 20, note: 'Message inspection not available for this adapter' },
      };
      await next();
      return;
    }

    const events = (eq as any).events as Map<string, any>;
    let fullChannel = channel;
    if (events?.has(channel)) {
      fullChannel = eq.getFullChannel(channel, events.get(channel)?.shared);
    }

    const queue = adapter.queues.get(fullChannel) || [];
    const start = (Number(page) - 1) * Number(pageSize);
    const slice = queue.slice(start, start + Number(pageSize));

    ctx.body = {
      data: slice.map((msg: any) => ({
        id: msg.id,
        content: msg.content,
        timestamp: msg.options?.timestamp,
        retried: msg.options?.retried || 0,
        maxRetries: msg.options?.maxRetries || 0,
      })),
      meta: { count: queue.length, page: Number(page), pageSize: Number(pageSize) },
    };
    await next();
  },
};
