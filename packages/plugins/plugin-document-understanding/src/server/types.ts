// SPDX-License-Identifier: Apache-2.0

import type {
  DocumentInputCoverage,
  DuOperationState,
  OperationProgress,
  OperationView,
  ProblemDetails,
  UsageMetrics,
  WaitState,
} from './contracts/du-contracts';

export type EngineMode = 'builtin' | 'du_rework' | 'hybrid';
export type ProtocolMode = 'builtin_du' | 'du_rework_v1' | 'legacy_rest';

export interface ServiceConfig {
  id?: number;
  baseUrl: string;
  authType: 'api_key' | 'bearer' | 'custom_header' | 'none';
  authKey?: string;
  authHeaderName?: string;
  defaultTimeout: number;
  defaultRetries: number;
  pollInterval: number;
  pollTimeout: number;
  webhookSecret?: string;
  engineMode?: EngineMode;
  llmService?: string;
  llmModel?: string;
  visionLlmService?: string;
  visionLlmModel?: string;
  maxFileSizeBytes?: number;
  maxFilesPerRequest?: number;
  publicGatewayEnabled?: boolean;
}

export type ClientServiceConfig = Omit<ServiceConfig, 'authKey' | 'webhookSecret'> & {
  hasAuthKey: boolean;
  hasWebhookSecret: boolean;
};

export interface EndpointDef {
  id: number;
  name: string;
  subpath: string;
  method: 'GET' | 'POST' | 'PUT';
  description?: string;
  requestBodySchema?: Record<string, unknown> | null;
  responseSchema?: Record<string, unknown> | null;
  fileInputMode: 'none' | 'multipart' | 'base64';
  fileFieldName?: string;
  maxFiles: number;
  executionMode: 'sync' | 'polling' | 'webhook';
  protocolMode?: ProtocolMode;
  businessId?: string;
  actionName?: string;
  /** Discriminator field name sent in the request body/query (e.g. 'mode'/'type'/'task'/'variant'/'process'). */
  discriminatorField?: string;
  /** Discriminator value for this endpoint (e.g. 'parse', 'invoice', 'disbursement'). */
  discriminatorValue?: string;
  /** When set, the request also appends '?sync=true' (legacy synchronous mode). */
  syncQueryParam?: string;
  /** Extract the async task ID with this path (e.g. 'operationId' or 'name') or regex. */
  taskIdExtractPath?: string;
  /** Regex used to extract the task ID from a string field (e.g. 'operations/([^/]+)'). */
  taskIdExtractRegex?: string;
  pollResultSubpath?: string;
  pollTaskIdField?: string;
  pollResultField?: string;
  pollInterval?: number;
  pollTimeout?: number;
  pollStatusField?: string;
  pollCompletedValue?: string;
  customHeaders?: Record<string, string>;
  enabled: boolean;
}

export interface PipelineStepDef {
  id: number;
  pipelineId: number;
  endpointId: number;
  stepOrder: number;
  name: string;
  inputMapping?: Record<string, unknown>;
  outputAlias?: string;
  condition?: Record<string, unknown> | null;
  onError: 'fail' | 'skip' | 'retry';
  retryCount: number;
  endpoint: EndpointDef;
}

export interface PipelineDef {
  id: number;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown> | null;
  outputMapping?: Record<string, unknown> | null;
  enabled: boolean;
  steps: PipelineStepDef[];
}

export type JobStatus =
  | 'pending'
  | 'running'
  | 'polling'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export interface JobState {
  id: number;
  pipelineId: number;
  status: JobStatus;
  input: Record<string, unknown>;
  currentStep: number;
  stepResults: Record<string, unknown>;
  finalResult?: unknown;
  error?: string;
  externalTaskIds: Record<string, string>;
  operationId?: string;
  waitState?: WaitState | null;
  usage?: UsageMetrics | null;
  startedAt?: Date;
  completedAt?: Date;
  ownedBy?: string;
  leaseExpiresAt?: Date | null;
}

export interface DuApiKeySummary {
  id: number;
  name: string;
  keyPrefix: string;
  tenantId: string;
  allowedBusinesses: string[];
  allowedActions: string[];
  requestDefaults?: Record<string, unknown> | null;
  lockedFields?: string[] | null;
  status: 'active' | 'revoked';
  expiresAt?: string | Date | null;
  lastUsedAt?: string | Date | null;
  createdAt?: string | Date;
}

export interface IssuedDuApiKey extends DuApiKeySummary {
  rawKey: string;
}

export interface UsageSummaryView {
  from: string;
  to: string;
  totalOperations: number;
  inputTokens: number;
  outputTokens: number;
  costMicrousd: number;
  byBusiness: Array<{
    businessId: string;
    action: string;
    operations: number;
    inputTokens: number;
    outputTokens: number;
    costMicrousd: number;
  }>;
}

export type {
  DocumentInputCoverage,
  DuOperationState,
  OperationProgress,
  OperationView,
  ProblemDetails,
  UsageMetrics,
  WaitState,
};
