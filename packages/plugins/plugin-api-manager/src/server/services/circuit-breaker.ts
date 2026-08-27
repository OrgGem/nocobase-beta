import { ApimError } from './errors';
import { envInt } from './env';
import {
  DEFAULT_CIRCUIT_BREAKER_ENABLED,
  DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  DEFAULT_CIRCUIT_BREAKER_OPEN_DURATION_MS,
  DEFAULT_CIRCUIT_BREAKER_COUNT_SERVER_ERRORS,
  ERROR_CODES,
} from '../../constants';

/**
 * Process-local circuit breaker keyed by target URL.
 *
 * The breaker observes consecutive upstream failures (network errors, HTTP 5xx,
 * and timeouts) for a target. Once `failureThreshold` consecutive failures are
 * recorded, the breaker opens and rejects subsequent calls immediately with
 * `503 APIM_CIRCUIT_OPEN` for `openDurationMs` without touching the target.
 * After the open duration elapses the breaker moves to half-open: the next call
 * is allowed through as a probe. A probe success closes the breaker; a probe
 * failure re-opens it for another `openDurationMs`.
 *
 * This implementation is process-local. In a multi-instance deployment each
 * process maintains its own breaker, which is acceptable for shedding load per
 * instance; a distributed/Redis-backed adapter should replace it when
 * cluster-wide signal propagation is required.
 */

export interface CircuitBreakerOptions {
  enabled: boolean;
  failureThreshold: number;
  openDurationMs: number;
  /** When `true`, any HTTP 5xx counts as a failure. */
  countServerErrors: boolean;
}

export interface CircuitDecision {
  allowed: boolean;
  openMs?: number;
}

type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitEntry {
  state: CircuitState;
  failures: number;
  openedAt: number;
}

export function circuitOpenError(circuitOpenRetryAfterSec: number): ApimError {
  return new ApimError(
    ERROR_CODES.CIRCUIT_OPEN,
    `Target is temporarily unavailable (circuit open); retry after ${circuitOpenRetryAfterSec}s`,
    503,
  );
}

export class CircuitBreaker {
  private readonly circuits = new Map<string, CircuitEntry>();
  /**
   * Hard ceiling on tracked circuits. Keys are target URLs, so an unbounded
   * map would grow with every distinct upstream; when the ceiling is hit
   * the oldest insertion is evicted (its failure history is simply reset).
   */
  private readonly maxCircuits: number;

  constructor(maxCircuits = 10000) {
    this.maxCircuits = maxCircuits;
  }

  private getOrCreate(key: string): CircuitEntry {
    let entry = this.circuits.get(key);
    if (entry) return entry;
    if (this.circuits.size >= this.maxCircuits) {
      const oldest = this.circuits.keys().next().value;
      if (oldest != null) this.circuits.delete(oldest);
    }
    entry = { state: 'closed', failures: 0, openedAt: 0 };
    this.circuits.set(key, entry);
    return entry;
  }

  beforeRequest(key: string, options: CircuitBreakerOptions): CircuitDecision {
    if (!options.enabled) return { allowed: true };

    const entry = this.getOrCreate(key);

    if (entry.state === 'open') {
      const elapsed = Date.now() - entry.openedAt;
      if (elapsed < options.openDurationMs) {
        return { allowed: false, openMs: options.openDurationMs - elapsed };
      }
      entry.state = 'half-open';
    }

    return { allowed: true };
  }

  recordSuccess(key: string): void {
    const entry = this.getOrCreate(key);
    entry.failures = 0;
    entry.state = 'closed';
  }

  recordFailure(key: string, options: CircuitBreakerOptions): void {
    if (!options.enabled) return;

    const entry = this.getOrCreate(key);
    entry.failures += 1;
    if (entry.failures >= options.failureThreshold) {
      entry.state = 'open';
      entry.openedAt = Date.now();
    }
  }

  getStats(): Record<string, CircuitEntry> {
    return Object.fromEntries(this.circuits.entries());
  }
}

export function loadCircuitBreakerOptions(): CircuitBreakerOptions {
  return {
    enabled: process.env.APIM_CIRCUIT_BREAKER_ENABLED !== 'false',
    failureThreshold: Math.max(
      1,
      envInt('APIM_CIRCUIT_BREAKER_FAILURE_THRESHOLD', DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD),
    ),
    openDurationMs: Math.max(
      1,
      envInt('APIM_CIRCUIT_BREAKER_OPEN_DURATION_MS', DEFAULT_CIRCUIT_BREAKER_OPEN_DURATION_MS),
    ),
    countServerErrors: process.env.APIM_CIRCUIT_BREAKER_COUNT_SERVER_ERRORS !== 'false',
  };
}
