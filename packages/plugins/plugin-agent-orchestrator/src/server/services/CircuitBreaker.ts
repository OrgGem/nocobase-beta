export interface CircuitState {
  failures: number;
  lastFailureTime: number;
  state: 'closed' | 'open' | 'half-open';
}

/**
 * CircuitBreakerRegistry — prevents cascading failures by tracking per-key
 * failure rates and temporarily stopping calls when thresholds are exceeded.
 *
 * State machine: closed → open (after threshold failures) → half-open (after recoveryTimeout)
 * half-open: allows 1 probe request; success → closed, failure → open.
 */
export class CircuitBreakerRegistry {
  private readonly circuits = new Map<string, CircuitState>();

  readonly threshold: number;
  readonly recoveryTimeout: number;
  readonly halfOpenMaxRequests: number;
  private readonly appLog: any;

  constructor(options?: { threshold?: number; recoveryTimeout?: number; halfOpenMaxRequests?: number; appLog?: any }) {
    this.threshold = options?.threshold ?? 3;
    this.recoveryTimeout = options?.recoveryTimeout ?? 30000;
    this.halfOpenMaxRequests = options?.halfOpenMaxRequests ?? 1;
    this.appLog = options?.appLog;
  }

  private getOrCreate(key: string): CircuitState {
    let state = this.circuits.get(key);
    if (!state) {
      state = { failures: 0, lastFailureTime: 0, state: 'closed' };
      this.circuits.set(key, state);
    }
    return state;
  }

  recordSuccess(key: string): void {
    const state = this.getOrCreate(key);
    if (state.state === 'half-open') {
      state.state = 'closed';
      state.failures = 0;
      this.appLog?.debug?.(`[CircuitBreaker] "${key}" recovered → closed`);
    } else if (state.state === 'closed' && state.failures > 0) {
      // Decrement failure count on success (graceful recovery)
      state.failures = Math.max(0, state.failures - 1);
    }
  }

  recordFailure(key: string): void {
    const state = this.getOrCreate(key);
    state.failures += 1;
    state.lastFailureTime = Date.now();

    if (state.state === 'half-open') {
      state.state = 'open';
      this.appLog?.warn?.(`[CircuitBreaker] "${key}" half-open probe failed → open`);
    } else if (state.state === 'closed' && state.failures >= this.threshold) {
      state.state = 'open';
      this.appLog?.warn?.(`[CircuitBreaker] "${key}" opened after ${state.failures} failures`);
    }
  }

  isAllowed(key: string): boolean {
    const state = this.getOrCreate(key);

    if (state.state === 'closed') return true;

    if (state.state === 'open') {
      const elapsed = Date.now() - state.lastFailureTime;
      if (elapsed >= this.recoveryTimeout) {
        state.state = 'half-open';
        this.appLog?.debug?.(`[CircuitBreaker] "${key}" open timeout elapsed → half-open`);
        return true;
      }
      return false;
    }

    // half-open: allow limited probe requests
    return this.halfOpenMaxRequests > 0;
  }

  getState(key: string): CircuitState | null {
    return this.circuits.get(key) ?? null;
  }

  /** Reset a circuit back to closed state. */
  reset(key: string): void {
    const state = this.circuits.get(key);
    if (state) {
      state.state = 'closed';
      state.failures = 0;
      state.lastFailureTime = 0;
    }
  }

  /** Get all circuit state keys (for monitoring/diagnostics). */
  getKeys(): string[] {
    return Array.from(this.circuits.keys());
  }
}

/**
 * Build the circuit key for a sub-agent. Keying by `${leader}::${target}` keeps
 * one leader's failures from opening the circuit for the same sub-agent under a
 * different leader — their delegations are independent code paths. Falls back to
 * the bare target when no leader is known.
 */
export function subAgentCircuitKey(leaderUsername: string | undefined, target: string): string {
  return leaderUsername ? `${leaderUsername}::${target}` : target;
}

// Singleton shared across the plugin
let globalInstance: CircuitBreakerRegistry | null = null;

export function getCircuitBreaker(options?: {
  threshold?: number;
  recoveryTimeout?: number;
  halfOpenMaxRequests?: number;
  appLog?: any;
}): CircuitBreakerRegistry {
  if (!globalInstance) {
    globalInstance = new CircuitBreakerRegistry(options);
  }
  return globalInstance;
}
