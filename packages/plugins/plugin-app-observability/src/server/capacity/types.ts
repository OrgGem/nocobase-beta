export type CapacityState = 'healthy' | 'watch' | 'scale-soon' | 'critical';
export interface CapacityMessage {
  key: string;
  values?: Record<string, number | string>;
}
export interface CapacitySignal {
  key: string;
  utilization: number | null;
  headroom: number | null;
  reliable: boolean;
  evidence: CapacityMessage;
}
export interface CapacityAssessment {
  state: CapacityState;
  confidence: number;
  constrainingSignal: string | null;
  signals: CapacitySignal[];
  evidence: CapacityMessage[];
  recommendation: CapacityMessage;
  thresholdCrossingAt: number | null;
  calibration: { safeRequestRate?: number; source?: string } | null;
}
