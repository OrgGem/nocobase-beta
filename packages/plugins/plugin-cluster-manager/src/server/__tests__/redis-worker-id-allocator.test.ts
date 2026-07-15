import type { Logger } from '@nocobase/logger';
import { vi } from 'vitest';

const leases = new Map<string, string>();

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
    if (command[0] === 'SET') {
      const [, key, owner] = command;
      if (leases.has(key)) return null;
      leases.set(key, owner);
      return 'OK';
    }
    if (command[0] === 'EVAL') {
      const key = command[3];
      const owner = command[4];
      if (leases.get(key) !== owner) return 0;
      if (command[1].includes('del')) leases.delete(key);
      return 1;
    }
    return null;
  }
}

vi.mock('redis', () => ({
  createClient: () => new FakeRedisClient(),
}));

import { RedisWorkerIdAllocator } from '../adapters/redis-worker-id-allocator';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

describe('RedisWorkerIdAllocator', () => {
  beforeEach(() => leases.clear());

  it('allocates different worker IDs to concurrent app instances', async () => {
    const first = new RedisWorkerIdAllocator('redis://test', 'main', logger);
    const second = new RedisWorkerIdAllocator('redis://test', 'main', logger);

    const [firstId, secondId] = await Promise.all([first.getWorkerId(), second.getWorkerId()]);

    expect(firstId).toBe(0);
    expect(secondId).toBe(1);
    expect(first.getStatus().healthy).toBe(true);
    expect(second.getStatus().healthy).toBe(true);

    await first.release();
    await second.release();
  });

  it('releases only its owned worker ID lease', async () => {
    const allocator = new RedisWorkerIdAllocator('redis://test', 'main', logger);
    expect(await allocator.getWorkerId()).toBe(0);
    expect(leases.size).toBe(1);

    await allocator.release();

    expect(leases.size).toBe(0);
    expect(allocator.getStatus().healthy).toBe(false);
  });
});
