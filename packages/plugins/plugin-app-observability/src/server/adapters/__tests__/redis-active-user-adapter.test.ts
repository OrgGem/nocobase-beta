import { describe, expect, it, vi } from 'vitest';
import { RedisActiveUserAdapter } from '../redis-active-user-adapter';

describe('RedisActiveUserAdapter', () => {
  it('uses bounded HLL time buckets with a non-raw user identifier', async () => {
    const client = {
      pfAdd: vi.fn().mockResolvedValue(1),
      pfCount: vi.fn().mockResolvedValue(7),
      expire: vi.fn().mockResolvedValue(1),
    };
    const adapter = new RedisActiveUserAdapter(client, {
      appName: 'main',
      secret: 'shared-secret',
      now: () => 125_000,
    });

    await adapter.observe('user-42', 300);
    await expect(adapter.count(300)).resolves.toBe(7);

    expect(client.pfAdd).toHaveBeenCalledWith('nocobase:main:app-observability:active-users:120000', [
      expect.not.stringContaining('user-42'),
    ]);
    expect(client.expire).toHaveBeenCalledWith('nocobase:main:app-observability:active-users:120000', 360);
    expect(client.pfCount).toHaveBeenCalledWith(
      expect.arrayContaining(['nocobase:main:app-observability:active-users:120000']),
    );
  });

  it('falls back cleanly when the Redis client does not support HyperLogLog commands', async () => {
    const adapter = new RedisActiveUserAdapter({}, { appName: 'main', secret: 'shared-secret' });
    expect(adapter.supported).toBe(false);
    await expect(adapter.observe('user-42', 300)).resolves.toBeUndefined();
    await expect(adapter.count(300)).resolves.toBeNull();
  });
});
