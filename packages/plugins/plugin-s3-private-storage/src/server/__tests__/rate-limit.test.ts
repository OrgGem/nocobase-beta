import { SlidingWindowRateLimiter, getStreamRateLimitConfigFromEnv } from '../rate-limit';

describe('SlidingWindowRateLimiter', () => {
  it('allows requests up to the max within the window', () => {
    const limiter = new SlidingWindowRateLimiter({ max: 3, windowMs: 1000 });
    expect(limiter.check('k', 100).allowed).toBe(true);
    expect(limiter.check('k', 110).allowed).toBe(true);
    expect(limiter.check('k', 120).allowed).toBe(true);
    expect(limiter.check('k', 130).allowed).toBe(false);
  });

  it('reports retryAfterSec when the limit is hit', () => {
    const limiter = new SlidingWindowRateLimiter({ max: 1, windowMs: 1000 });
    limiter.check('k', 100);
    const decision = limiter.check('k', 600);
    expect(decision.allowed).toBe(false);
    // oldest hit at 100ms + 1000ms window = 1100ms; now = 600ms → 500ms → ceil 1s
    expect(decision.retryAfterSec).toBe(1);
  });

  it('slides the window: old hits expire', () => {
    const limiter = new SlidingWindowRateLimiter({ max: 2, windowMs: 1000 });
    limiter.check('k', 100);
    limiter.check('k', 200);
    // both hits are older than 1000ms now
    expect(limiter.check('k', 1101).allowed).toBe(true);
  });

  it('tracks keys independently', () => {
    const limiter = new SlidingWindowRateLimiter({ max: 1, windowMs: 1000 });
    expect(limiter.check('a', 0).allowed).toBe(true);
    expect(limiter.check('b', 0).allowed).toBe(true);
    expect(limiter.check('a', 1).allowed).toBe(false);
    expect(limiter.check('b', 1).allowed).toBe(false);
    expect(limiter.size()).toBe(2);
  });

  it('prunes expired buckets', () => {
    const limiter = new SlidingWindowRateLimiter({ max: 1, windowMs: 1000 });
    limiter.check('a', 0);
    limiter.check('b', 1);
    expect(limiter.size()).toBe(2);
    limiter.prune(2000);
    expect(limiter.size()).toBe(0);
  });

  it('dispose clears state and stops the timer', () => {
    const limiter = new SlidingWindowRateLimiter({ max: 1, windowMs: 1000 });
    limiter.check('a', 0);
    limiter.dispose();
    expect(limiter.size()).toBe(0);
  });

  it('rejects invalid configuration', () => {
    expect(() => new SlidingWindowRateLimiter({ max: 0, windowMs: 1000 })).toThrow();
    expect(() => new SlidingWindowRateLimiter({ max: 1, windowMs: 0 })).toThrow();
  });
});

describe('getStreamRateLimitConfigFromEnv', () => {
  it('applies defaults when no env vars are set', () => {
    const config = getStreamRateLimitConfigFromEnv({});
    expect(config).toEqual({ enabled: true, max: 120, windowMs: 60000 });
  });

  it('disables when S3_PRIVATE_STREAM_RATE_LIMIT_ENABLED=false', () => {
    const config = getStreamRateLimitConfigFromEnv({ S3_PRIVATE_STREAM_RATE_LIMIT_ENABLED: 'false' });
    expect(config.enabled).toBe(false);
  });

  it('reads custom max and window', () => {
    const config = getStreamRateLimitConfigFromEnv({
      S3_PRIVATE_STREAM_RATE_LIMIT_MAX: '50',
      S3_PRIVATE_STREAM_RATE_LIMIT_WINDOW_MS: '10000',
    });
    expect(config).toEqual({ enabled: true, max: 50, windowMs: 10000 });
  });

  it('falls back to defaults for invalid values', () => {
    const config = getStreamRateLimitConfigFromEnv({
      S3_PRIVATE_STREAM_RATE_LIMIT_MAX: 'abc',
      S3_PRIVATE_STREAM_RATE_LIMIT_WINDOW_MS: '-5',
    });
    expect(config.max).toBe(120);
    expect(config.windowMs).toBe(60000);
  });
});
