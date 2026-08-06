export type CapacityState = 'healthy' | 'watch' | 'scale-soon' | 'critical';
export interface CapacitySignal {
  key: string;
  utilization: number | null;
  headroom: number | null;
  reliable: boolean;
  evidence: string;
}
export interface CapacityAssessment {
  state: CapacityState;
  confidence: number;
  constrainingSignal: string | null;
  signals: CapacitySignal[];
  evidence: string[];
  recommendation: string;
  thresholdCrossingAt: number | null;
  calibration: { safeRequestRate?: number; source?: string } | null;
}
