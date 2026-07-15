import type { Application } from '@nocobase/server';
import { vi } from 'vitest';

const commands: string[][] = [];
const entries: unknown[] = [];

class FakeRedisClient {
  isOpen = false;
  isReady = false;

  on() {
    return this;
  }

  async connect() {
    this.isOpen = true;
    this.isReady = true;
  }

  async quit() {
    this.isOpen = false;
    this.isReady = false;
  }

  destroy() {
    this.isOpen = false;
    this.isReady = false;
  }

  async sendCommand(command: string[]) {
    commands.push(command);
    if (command[0] === 'XGROUP') return 'OK';
    if (command[0] === 'XADD') {
      const messageField = command.indexOf('message');
      if (!command[1].endsWith(':dlq') && messageField >= 0) {
        entries.push(['1-0', ['message', command[messageField + 1]]]);
      }
      return '1-0';
    }
    if (command[0] === 'XAUTOCLAIM') return ['0-0', []];
    if (command[0] === 'XREADGROUP') {
      if (entries.length === 0) return null;
      return [[command[command.length - 2], [entries.shift()]]];
    }
    if (command[0] === 'XACK') return 1;
    if (command[0] === 'XCLAIM') return ['1-0'];
    return null;
  }
}

vi.mock('redis', () => ({
  createClient: () => new FakeRedisClient(),
}));

import { RedisEventQueueAdapter } from '../adapters/redis-event-queue-adapter';

const app = {
  name: 'main',
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
} as unknown as Application;

describe('RedisEventQueueAdapter', () => {
  beforeEach(() => {
    commands.length = 0;
    entries.length = 0;
  });

  it('acknowledges a stream message only after processing succeeds', async () => {
    const processed = vi.fn();
    let resolveProcessed: (() => void) | undefined;
    const processedSignal = new Promise<void>((resolve) => {
      resolveProcessed = resolve;
    });
    const adapter = new RedisEventQueueAdapter({ app, url: 'redis://test' });
    adapter.subscribe('main.workflow:process', {
      idle: () => true,
      process: async (message) => {
        processed(message);
        resolveProcessed?.();
      },
    });

    await adapter.connect();
    await adapter.publish('main.workflow:process', { executionId: 42 });
    await processedSignal;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await adapter.close();

    expect(processed).toHaveBeenCalledWith({ executionId: 42 });
    expect(commands.some((command) => command[0] === 'XADD')).toBe(true);
    expect(commands.some((command) => command[0] === 'XACK')).toBe(true);
    expect(commands.some((command) => command[0] === 'LPOP')).toBe(false);
  });
});
