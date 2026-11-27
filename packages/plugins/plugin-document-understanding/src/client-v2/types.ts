// SPDX-License-Identifier: Apache-2.0

export type {
  ServiceConfig,
  ClientServiceConfig,
  EndpointDef,
  PipelineStepDef,
  PipelineDef,
  JobState,
  JobStatus,
  EngineMode,
  ProtocolMode,
  DuApiKeySummary,
  IssuedDuApiKey,
  OperationView,
  UsageSummaryView,
  UsageMetrics,
  WaitState,
  DocumentInputCoverage,
  DuOperationState,
} from '../server/types';

export interface ApiEnvelope<T> {
  data?: {
    data?: T;
    meta?: { count?: number };
  };
}

export function unwrapData<T>(response: unknown, fallback: T): T {
  if (!response || typeof response !== 'object') return fallback;
  const outer = response as ApiEnvelope<T>;
  return outer.data?.data ?? fallback;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}
