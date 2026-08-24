import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from '../services/rate-limiter';

describe('FixedWindowRateLimiter', () => {
  it('allows requests up to the max within a window', () => {
    const limiter = new FixedWindowRateLimiter();
    for (let i = 0; i < 5; i++) {
      expect(limiter.check('key-a', 5, 60).allowed).toBe(true);
    }
    expect(limiter.check('key-a', 5, 60).allowed).toBe(false);
  });

  it('tracks keys independently', () => {
    const limiter = new FixedWindowRateLimiter();
    for (let i = 0; i < 3; i++) limiter.check('key-a', 3, 60);
    expect(limiter.check('key-a', 3, 60).allowed).toBe(false);
    expect(limiter.check('key-b', 3, 60).allowed).toBe(true);
  });

  it('returns a positive retryAfterSec when blocked', () => {
    const limiter = new FixedWindowRateLimiter();
    limiter.check('key-a', 1, 60);
    const result = limiter.check('key-a', 1, 60);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSec).toBeGreaterThan(0);
    expect(result.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it('resets the window after it expires', async () => {
    const limiter = new FixedWindowRateLimiter();
    expect(limiter.check('key-a', 1, 1).allowed).toBe(true);
    expect(limiter.check('key-a', 1, 1).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(limiter.check('key-a', 1, 1).allowed).toBe(true);
  });

  it('prunes entries once their own window has elapsed, not after 24 h', async () => {
    const limiter = new FixedWindowRateLimiter(2);
    limiter.check('short-window', 10, 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    // With a 1 s window the entry is fully elapsed and can be pruned to make room.
    limiter.check('other', 10, 60);
    expect(limiter.size).toBeLessThanOrEqual(2);
    // The expired short-window entry restarts its counter instead of being blocked.
    expect(limiter.check('short-window', 10, 1).allowed).toBe(true);
  });

  it('evicts only expired entries when pruning at capacity', async () => {
    const limiter = new FixedWindowRateLimiter(2);
    limiter.check('expiring', 10, 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    limiter.check('live', 10, 60);
    // Map is at capacity (2); adding another prunes 'expiring' but keeps 'live'.
    limiter.check('third', 10, 60);
    expect(limiter.size).toBe(2);
    expect(limiter.check('live', 10, 60).allowed).toBe(true);
    expect(limiter.check('expiring', 10, 1).allowed).toBe(true);
  });

  it('evicts oldest entries when the map is full', () => {
    const limiter = new FixedWindowRateLimiter(2);
    limiter.check('a', 10, 60);
    limiter.check('b', 10, 60);
    limiter.check('c', 10, 60);
    // 'a' was evicted, so its counter restarted.
    expect(limiter.check('a', 10, 60).allowed).toBe(true);
  });
});
