import { describe, expect, it } from 'vitest';
import { CircuitBreaker, circuitOpenError, loadCircuitBreakerOptions } from '../services/circuit-breaker';

function options(overrides: Partial<ReturnType<typeof loadCircuitBreakerOptions>> = {}) {
  return {
    enabled: true,
    failureThreshold: 2,
    openDurationMs: 1000,
    countServerErrors: true,
    ...overrides,
  };
}

describe('CircuitBreaker', () => {
  it('allows requests when closed', () => {
    const cb = new CircuitBreaker();
    expect(cb.beforeRequest('target-a', options()).allowed).toBe(true);
  });

  it('opens after the failure threshold is reached', () => {
    const cb = new CircuitBreaker();
    const opts = options();
    cb.recordFailure('target-a', opts);
    expect(cb.beforeRequest('target-a', opts).allowed).toBe(true);
    cb.recordFailure('target-a', opts);
    expect(cb.beforeRequest('target-a', opts).allowed).toBe(false);
  });

  it('rejects with a 503 circuit-open error while open', () => {
    const cb = new CircuitBreaker();
    const opts = options();
    cb.recordFailure('target-a', opts);
    cb.recordFailure('target-a', opts);
    const decision = cb.beforeRequest('target-a', opts);
    expect(decision.allowed).toBe(false);
    const err = circuitOpenError(Math.max(1, Math.ceil((decision.openMs as number) / 1000)));
    expect(err.httpStatus).toBe(503);
  });

  it('does not count success-status responses as failures', () => {
    const cb = new CircuitBreaker();
    const opts = options();
    cb.recordSuccess('target-a');
    expect(cb.getStats()['target-a'].failures).toBe(0);
  });

  it('transitions to half-open after the open duration', async () => {
    const cb = new CircuitBreaker();
    const opts = options({ openDurationMs: 20 });
    cb.recordFailure('target-a', opts);
    cb.recordFailure('target-a', opts);
    expect(cb.beforeRequest('target-a', opts).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cb.beforeRequest('target-a', opts).allowed).toBe(true);
  });

  it('re-opens after a half-open probe fails', async () => {
    const cb = new CircuitBreaker();
    const opts = options({ failureThreshold: 1, openDurationMs: 20 });
    cb.recordFailure('target-a', opts);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cb.beforeRequest('target-a', opts).allowed).toBe(true);
    cb.recordFailure('target-a', opts);
    expect(cb.beforeRequest('target-a', opts).allowed).toBe(false);
  });

  it('always allows when disabled', () => {
    const cb = new CircuitBreaker();
    const opts = options({ enabled: false });
    cb.recordFailure('target-a', opts);
    cb.recordFailure('target-a', opts);
    expect(cb.beforeRequest('target-a', opts).allowed).toBe(true);
  });
});
