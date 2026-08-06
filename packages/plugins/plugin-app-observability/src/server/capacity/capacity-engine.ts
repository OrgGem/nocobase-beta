import type { NodeObservabilitySnapshot } from '../contracts';
import type { CapacityAssessment, CapacitySignal, CapacityState } from './types';

export interface CapacityInput {
  cpuPercent?: number | null;
  memoryPercent?: number | null;
  eventLoopUtilizationPercent?: number | null;
  eventLoopDelayP99Ms?: number | null;
  dbWaitRatioPercent?: number | null;
  errorRatePercent?: number | null;
}
export interface CapacityThresholds {
  cpu?: number;
  memory?: number;
  eventLoop?: number;
  eventLoopDelayMs?: number;
  dbWait?: number;
  errors?: number;
}
export function assessCapacity(input: CapacityInput, thresholds: CapacityThresholds = {}): CapacityAssessment {
  const signals = [
    signal('cpu', input.cpuPercent, thresholds.cpu ?? 75, '%'),
    signal('memory', input.memoryPercent, thresholds.memory ?? 80, '%'),
    signal('event-loop', input.eventLoopUtilizationPercent, thresholds.eventLoop ?? 70, '%'),
    signal('event-loop-delay', input.eventLoopDelayP99Ms, thresholds.eventLoopDelayMs ?? 100, 'ms'),
    signal('db-wait', input.dbWaitRatioPercent, thresholds.dbWait ?? 5, '%'),
    signal('errors', input.errorRatePercent, thresholds.errors ?? 5, '%'),
  ];
  const reliable = signals.filter(isReliableSignal);
  if (reliable.length === 0)
    return {
      state: 'watch',
      confidence: 0.15,
      constrainingSignal: null,
      signals,
      evidence: ['Insufficient reliable runtime signals.'],
      recommendation: 'Collect more runtime samples before changing capacity.',
      thresholdCrossingAt: null,
      calibration: null,
    };
  const constraining = reliable.reduce((left, right) => (right.utilization > left.utilization ? right : left));
  const state = stateFor(constraining.utilization);
  return {
    state,
    confidence: Math.round((reliable.length / signals.length) * 100) / 100,
    constrainingSignal: constraining.key,
    signals,
    evidence: reliable.filter((item) => item.utilization >= 70).map((item) => item.evidence),
    recommendation: recommendationFor(state, constraining.key),
    thresholdCrossingAt: null,
    calibration: null,
  };
}
function isReliableSignal(
  signalValue: CapacitySignal,
): signalValue is CapacitySignal & { utilization: number; headroom: number } {
  return signalValue.reliable && signalValue.utilization !== null && signalValue.headroom !== null;
}
export function assessCapacityFromSnapshot(
  snapshot: NodeObservabilitySnapshot,
  thresholds?: CapacityThresholds,
): CapacityAssessment {
  const runtime = snapshot.runtime;
  const services = Object.values(snapshot.services);
  const requests = services.reduce((sum, service) => sum + service.requestCount, 0);
  const errors = services.reduce((sum, service) => sum + service.failureCount + service.rejectedCount, 0);
  return assessCapacity(
    {
      cpuPercent: runtime?.cpuPercent,
      memoryPercent:
        runtime && runtime.effectiveMemoryLimitBytes > 0
          ? (runtime.rssBytes / runtime.effectiveMemoryLimitBytes) * 100
          : null,
      eventLoopUtilizationPercent: runtime?.eventLoopUtilization == null ? null : runtime.eventLoopUtilization * 100,
      eventLoopDelayP99Ms: runtime?.eventLoopDelayP99Ms,
      dbWaitRatioPercent:
        runtime?.dbPoolWaiting == null || runtime.dbPoolActive == null
          ? null
          : (runtime.dbPoolWaiting / Math.max(1, runtime.dbPoolActive + runtime.dbPoolWaiting)) * 100,
      errorRatePercent: requests ? (errors / requests) * 100 : null,
    },
    thresholds,
  );
}
function signal(key: string, value: number | null | undefined, threshold: number, unit: string): CapacitySignal {
  if (value == null || !Number.isFinite(value))
    return { key, utilization: null, headroom: null, reliable: false, evidence: `${key} is unavailable.` };
  const utilization = Math.max(0, (value / threshold) * 100);
  return {
    key,
    utilization,
    headroom: Math.max(0, 100 - utilization),
    reliable: true,
    evidence: `${key} is ${round(value)}${unit} against ${threshold}${unit}.`,
  };
}
function stateFor(value: number): CapacityState {
  if (value >= 120) return 'critical';
  if (value >= 100) return 'scale-soon';
  if (value >= 80) return 'watch';
  return 'healthy';
}
function recommendationFor(state: CapacityState, key: string): string {
  if (state === 'healthy') return 'No capacity change is recommended.';
  if (state === 'watch') return `Watch ${key} and validate trends.`;
  if (state === 'scale-soon') return `Plan capacity for ${key}; no automatic scaling is performed.`;
  return `Investigate ${key} saturation immediately; no automatic scaling is performed.`;
}
function round(value: number): number {
  return Math.round(value * 10) / 10;
}
