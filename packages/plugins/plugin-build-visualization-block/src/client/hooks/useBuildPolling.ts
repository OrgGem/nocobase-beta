import { useEffect, useRef, useState } from 'react';
import { useAPIClient } from '@nocobase/client';

import { BUILD_PHASES, BuildPhase, COLLECTION_NAME } from '../../shared/constants';

/**
 * The narrowed shape of a single `aiVisualizationBuilds:getResult` record, as
 * consumed by the client while polling a build. Every field mirrors the server
 * `getResult` body; the generated outputs (`blockSchema`/`blockSpec`/
 * `adjustments`) are intentionally `unknown` because their concrete shape is
 * only meaningful once the build reaches a terminal phase, and the polling hook
 * is not responsible for interpreting them.
 */
export interface BuildResultRecord {
  /** Primary key of the build record. */
  id: string | number;
  /** Coarse build status (`building` | `completed` | `error`). */
  status: string;
  /** Fine-grained phase used to drive the progress UI and stop polling. */
  buildPhase: BuildPhase;
  /** The generated Formily block schema once `buildPhase === 'completed'`. */
  blockSchema: unknown;
  /** The validated `BlockSpec` the schema was generated from. */
  blockSpec: unknown;
  /** The validator's remap/remove adjustments summary, when present. */
  adjustments: unknown;
  /** Whether the grounded fallback spec was used for this build. */
  usedFallback: boolean;
  /** A human-readable error message when the build failed, else `null`. */
  errorMessage: string | null;
}

/** Options accepted by {@link useBuildPolling}. */
export interface BuildPollingOptions {
  /** Poll interval in milliseconds while the build is in progress. */
  intervalMs?: number;
  /** When `false`, polling is suspended (and any running timer is cleared). */
  enabled?: boolean;
}

/**
 * The reactive result returned by {@link useBuildPolling}.
 *
 * `phase`/`status` are convenience projections of `record` so callers can
 * render the current phase without re-narrowing the record themselves.
 */
export type BuildPollingResult = {
  /** Current build phase, or `undefined` before the first successful poll. */
  phase: BuildPhase | undefined;
  /** Current coarse status, or `undefined` before the first successful poll. */
  status: string | undefined;
  /** The latest polled record, or `undefined` before the first poll. */
  record: BuildResultRecord | undefined;
  /** The most recent polling error, cleared on the next successful poll. */
  error: Error | undefined;
  /** Whether a poll request is currently in flight. */
  loading: boolean;
};

/** Default poll interval (Req 10.5): ~2 s while a build is in progress. */
const DEFAULT_INTERVAL_MS = 2000;

/** Phases at which a build is finished and polling must stop. */
function isTerminalPhase(phase: BuildPhase | undefined): boolean {
  return phase === 'completed' || phase === 'failed';
}

/** Type guard narrowing an arbitrary value to a known {@link BuildPhase}. */
function isBuildPhase(value: unknown): value is BuildPhase {
  return typeof value === 'string' && (BUILD_PHASES as string[]).includes(value);
}

/**
 * Safely unwrap the API client response to the record body. NocoBase action
 * responses are double-wrapped (`res.data.data`), so both levels are checked
 * structurally without resorting to `any`.
 */
function extractResponseData(res: unknown): unknown {
  if (res && typeof res === 'object') {
    const outer = (res as { data?: unknown }).data;
    if (outer && typeof outer === 'object') {
      return (outer as { data?: unknown }).data;
    }
  }
  return undefined;
}

/**
 * Narrow the untyped `getResult` payload to a {@link BuildResultRecord}. Returns
 * `undefined` when the payload is missing or lacks a usable primary key, so the
 * caller never overwrites good state with a malformed response.
 */
function narrowRecord(value: unknown): BuildResultRecord | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  const id = v.id;
  if (typeof id !== 'string' && typeof id !== 'number') {
    return undefined;
  }
  return {
    id,
    status: typeof v.status === 'string' ? v.status : '',
    buildPhase: isBuildPhase(v.buildPhase) ? v.buildPhase : 'idle',
    blockSchema: v.blockSchema ?? undefined,
    blockSpec: v.blockSpec ?? undefined,
    adjustments: v.adjustments ?? undefined,
    usedFallback: v.usedFallback === true,
    errorMessage: typeof v.errorMessage === 'string' ? v.errorMessage : null,
  };
}

/**
 * Poll a build record until it reaches a terminal phase.
 *
 * Polls `aiVisualizationBuilds:getResult` every `intervalMs` (default 2000ms)
 * while the build is in progress and stops automatically when:
 * - the record phase is terminal (`completed` or `failed`),
 * - `options.enabled === false`, or
 * - `buildId` is `undefined`.
 *
 * The timer is cleared on unmount and whenever polling stops, and a tick is
 * skipped while a previous request is still in flight (a ref guard prevents
 * overlapping requests). Returns the current `phase`, `status`, `record`,
 * `error`, and `loading` state.
 *
 * _Requirements: 10.5_
 */
export function useBuildPolling(
  buildId: string | number | undefined,
  options: BuildPollingOptions = {},
): BuildPollingResult {
  const { intervalMs = DEFAULT_INTERVAL_MS, enabled = true } = options;
  const api = useAPIClient();

  const [record, setRecord] = useState<BuildResultRecord | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    // Nothing to poll: suspend and surface a clean, idle state.
    if (!enabled || buildId === undefined) {
      clearTimer();
      setLoading(false);
      return clearTimer;
    }

    let cancelled = false;

    const tick = async (): Promise<void> => {
      // Skip this tick if a request is still outstanding (ref guard).
      if (inFlightRef.current) {
        return;
      }
      inFlightRef.current = true;
      setLoading(true);
      try {
        const res = await api.resource(COLLECTION_NAME).getResult({ filterByTk: buildId });
        if (cancelled) {
          return;
        }
        const next = narrowRecord(extractResponseData(res));
        if (next) {
          setRecord(next);
          setError(undefined);
          // Stop once the build has finished; nothing more will change.
          if (isTerminalPhase(next.buildPhase)) {
            clearTimer();
          }
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e : new Error(String(e)));
        }
      } finally {
        inFlightRef.current = false;
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    // `tick` never rejects (it handles its own errors), so it is safe to invoke
    // directly from the effect and the interval callback.
    // Poll immediately, then on the interval until a terminal phase is reached.
    tick();
    timerRef.current = setInterval(tick, intervalMs);

    return () => {
      cancelled = true;
      clearTimer();
    };
  }, [api, buildId, enabled, intervalMs]);

  return {
    phase: record?.buildPhase,
    status: record?.status,
    record,
    error,
    loading,
  };
}

export default useBuildPolling;
