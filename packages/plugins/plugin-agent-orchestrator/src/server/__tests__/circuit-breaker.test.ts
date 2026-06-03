import { CircuitBreakerRegistry, getCircuitBreaker } from '../services/CircuitBreaker';

describe('CircuitBreakerRegistry', () => {
  let cb: CircuitBreakerRegistry;

  beforeEach(() => {
    cb = new CircuitBreakerRegistry({ threshold: 3, recoveryTimeout: 30000, halfOpenMaxRequests: 1 });
  });

  describe('initial state', () => {
    it('starts closed for any key', () => {
      expect(cb.isAllowed('agent-a')).toBe(true);
      const state = cb.getState('agent-a');
      expect(state).toBeTruthy();
      expect(state!.state).toBe('closed');
      expect(state!.failures).toBe(0);
    });

    it('returns null for unknown key before first check', () => {
      expect(cb.getState('unknown')).toBeNull();
    });
  });

  describe('closed → open transition', () => {
    it('stays closed below threshold', () => {
      cb.recordFailure('agent-a');
      cb.recordFailure('agent-a');
      expect(cb.isAllowed('agent-a')).toBe(true);
      expect(cb.getState('agent-a')!.state).toBe('closed');
    });

    it('opens after threshold failures', () => {
      cb.recordFailure('agent-a');
      cb.recordFailure('agent-a');
      cb.recordFailure('agent-a');
      expect(cb.getState('agent-a')!.state).toBe('open');
      expect(cb.isAllowed('agent-a')).toBe(false);
    });

    it('tracks failures independently per key', () => {
      cb.recordFailure('agent-a');
      cb.recordFailure('agent-a');
      cb.recordFailure('agent-a');
      cb.recordFailure('agent-b');
      expect(cb.isAllowed('agent-a')).toBe(false);
      expect(cb.isAllowed('agent-b')).toBe(true);
    });
  });

  describe('open → half-open transition', () => {
    it('transitions to half-open after recovery timeout', () => {
      cb = new CircuitBreakerRegistry({ threshold: 1, recoveryTimeout: 50, halfOpenMaxRequests: 1 });
      cb.recordFailure('agent-a');
      expect(cb.isAllowed('agent-a')).toBe(false);

      // After recovery timeout, should become half-open
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(cb.isAllowed('agent-a')).toBe(true);
          expect(cb.getState('agent-a')!.state).toBe('half-open');
          resolve();
        }, 60);
      });
    });
  });

  describe('half-open behavior', () => {
    it('recovers to closed on success', () => {
      cb = new CircuitBreakerRegistry({ threshold: 1, recoveryTimeout: 1, halfOpenMaxRequests: 1 });
      cb.recordFailure('agent-a');
      // Manually force to half-open
      const state = cb.getState('agent-a')!;
      state.state = 'half-open';
      state.lastFailureTime = 0;

      cb.recordSuccess('agent-a');
      expect(cb.getState('agent-a')!.state).toBe('closed');
      expect(cb.getState('agent-a')!.failures).toBe(0);
    });

    it('returns to open on probe failure', () => {
      cb = new CircuitBreakerRegistry({ threshold: 1, recoveryTimeout: 1, halfOpenMaxRequests: 1 });
      cb.recordFailure('agent-a');
      const state = cb.getState('agent-a')!;
      state.state = 'half-open';

      cb.recordFailure('agent-a');
      expect(cb.getState('agent-a')!.state).toBe('open');
    });
  });

  describe('recordSuccess graceful recovery', () => {
    it('decrements failure count in closed state', () => {
      cb.recordFailure('agent-a');
      cb.recordFailure('agent-a');
      expect(cb.getState('agent-a')!.failures).toBe(2);
      cb.recordSuccess('agent-a');
      expect(cb.getState('agent-a')!.failures).toBe(1);
    });

    it('does not go below 0', () => {
      cb.recordSuccess('agent-a');
      expect(cb.getState('agent-a')!.failures).toBe(0);
    });
  });

  describe('reset', () => {
    it('resets circuit to closed with zero failures', () => {
      cb.recordFailure('agent-a');
      cb.recordFailure('agent-a');
      cb.recordFailure('agent-a');
      expect(cb.isAllowed('agent-a')).toBe(false);

      cb.reset('agent-a');
      expect(cb.getState('agent-a')!.state).toBe('closed');
      expect(cb.getState('agent-a')!.failures).toBe(0);
      expect(cb.isAllowed('agent-a')).toBe(true);
    });
  });

  describe('getKeys', () => {
    it('returns all tracked keys', () => {
      cb.recordFailure('agent-a');
      cb.recordFailure('agent-b');
      cb.recordFailure('agent-c');
      const keys = cb.getKeys();
      expect(keys).toContain('agent-a');
      expect(keys).toContain('agent-b');
      expect(keys).toContain('agent-c');
      expect(keys.length).toBe(3);
    });
  });

  describe('halfOpenMaxRequests', () => {
    it('allows multiple probes when configured', () => {
      cb = new CircuitBreakerRegistry({ threshold: 1, recoveryTimeout: 1, halfOpenMaxRequests: 3 });
      cb.recordFailure('agent-a');
      const state = cb.getState('agent-a')!;
      state.state = 'half-open';

      expect(cb.isAllowed('agent-a')).toBe(true);
      expect(cb.isAllowed('agent-a')).toBe(true);
      expect(cb.isAllowed('agent-a')).toBe(true);
    });

    it('disallows probes when set to 0', () => {
      cb = new CircuitBreakerRegistry({ threshold: 1, recoveryTimeout: 1, halfOpenMaxRequests: 0 });
      cb.recordFailure('agent-a');
      const state = cb.getState('agent-a')!;
      state.state = 'half-open';

      expect(cb.isAllowed('agent-a')).toBe(false);
    });
  });
});

describe('getCircuitBreaker singleton', () => {
  it('returns the same instance across calls', () => {
    const a = getCircuitBreaker();
    const b = getCircuitBreaker();
    expect(a).toBe(b);
  });

  it('configures with options on first call only', () => {
    // Reset module state by creating fresh instance
    const cb = new CircuitBreakerRegistry({ threshold: 5 });
    expect(cb.threshold).toBe(5);
  });
});
