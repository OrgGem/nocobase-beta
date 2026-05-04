import type { CarboneOutputFormat } from './constants';

export interface CarboneSettingsRecord {
  id?: number;
  endpoint: string;
  apiToken?: string;
  carboneVersion: string;
  timeoutMs: number;
  maxRetries: number;
  defaultOutputFormat: CarboneOutputFormat;
  enableCache: boolean;
  cacheTTL: number;
  cacheMaxSize: number;
  enableMonitoring: boolean;
  monitoringRetentionDays: number;
  rateLimitPerMinute: number;
  keepRawInDatabase: boolean;
  outputStorageId?: number | null;
  cacheStorageId?: number | null;
  backupStorageId?: number | null;
}

export type PlaceholderNodeType = 'string' | 'number' | 'date' | 'boolean' | 'object' | 'array';

export interface PlaceholderNode {
  name: string;
  type: PlaceholderNodeType;
  path: string; // e.g. "d.user.name"
  formatters?: string[];
  children?: PlaceholderNode[]; // for object / array
}

export interface PlaceholderSchema {
  d: PlaceholderNode[];
  c?: PlaceholderNode[];
  warnings: string[]; // e.g. fragmented runs in DOCX
}

export interface RenderRequest {
  templateId: number | string; // NocoBase template id
  versionId?: number | string; // optional, defaults to current
  data: unknown; // JSON
  format: CarboneOutputFormat;
  filename?: string;
  caller?: { type: 'user' | 'api' | 'workflow' | 'action'; id?: string | number };
}

export interface RenderResponse {
  attachmentId: number;
  url: string;
  format: CarboneOutputFormat;
  size: number;
  cacheHit: boolean;
  durationMs: number;
}
