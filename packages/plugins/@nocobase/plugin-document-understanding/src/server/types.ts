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
}

export interface EndpointDef {
  id: number;
  name: string;
  subpath: string;
  method: 'GET' | 'POST' | 'PUT';
  description?: string;
  requestBodySchema?: any;
  responseSchema?: any;
  fileInputMode: 'none' | 'multipart' | 'base64';
  maxFiles: number;
  executionMode: 'sync' | 'polling' | 'webhook';
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
  inputMapping?: Record<string, any>;
  outputAlias?: string;
  condition?: any;
  onError: 'fail' | 'skip' | 'retry';
  retryCount: number;
  endpoint: EndpointDef; // Associated endpoint
}

export interface PipelineDef {
  id: number;
  name: string;
  description?: string;
  inputSchema?: any;
  outputMapping?: Record<string, any>;
  enabled: boolean;
  steps: PipelineStepDef[];
}

export interface JobState {
  id: number;
  pipelineId: number;
  status: 'pending' | 'running' | 'polling' | 'completed' | 'failed' | 'timeout';
  input: any;
  currentStep: number;
  stepResults: Record<string, any>;
  finalResult?: any;
  error?: string;
  externalTaskIds: Record<string, string>;
  startedAt?: Date;
  completedAt?: Date;
}
