/**
 * UiPath API Client Types
 *
 * Shared types for UiPath Orchestrator API interactions.
 */

// ─── Instance Config ───────────────────────────────────────────────
export interface UiPathInstanceConfig {
  id: number;
  name: string;
  deploymentType: 'cloud' | 'onPrem';
  baseUrl?: string;
  accountLogicalName?: string;
  tenantLogicalName?: string;
  tenantName?: string;
  apiBaseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  defaultFolderId?: number;
  defaultFolderKey?: string;
  defaultFolderPath?: string;
  ignoreSsl?: boolean;
}

// ─── Folder Context ────────────────────────────────────────────────
export interface FolderContext {
  folderId?: number;
  folderKey?: string;
  folderPath?: string;
}

// ─── OData Query ───────────────────────────────────────────────────
export interface ODataQuery {
  $top?: number;
  $skip?: number;
  $filter?: string;
  $select?: string;
  $expand?: string;
  $orderby?: string;
  $count?: boolean;
}

// ─── Request Options ───────────────────────────────────────────────
export interface UiPathRequestOptions {
  method?: string;
  query?: ODataQuery & Record<string, any>;
  body?: any;
  folder?: FolderContext;
  timeout?: number;
  /** Raw path params appended to endpoint */
  pathSuffix?: string;
}

// ─── Token Cache Entry ─────────────────────────────────────────────
export interface TokenCacheEntry {
  accessToken: string;
  expiresAt: number; // epoch ms
}

// ─── OData Response Envelope ───────────────────────────────────────
export interface ODataResponse<T = any> {
  '@odata.context'?: string;
  '@odata.count'?: number;
  value: T[];
}

// ─── Job ───────────────────────────────────────────────────────────
export interface UiPathJob {
  Id: number;
  Key: string;
  State: string;
  Source: string;
  SourceType: string;
  StartTime?: string;
  EndTime?: string;
  CreationTime: string;
  Info?: string;
  ReleaseName?: string;
  ReleaseKey?: string;
  OrganizationUnitId?: number;
  OrganizationUnitFullyQualifiedName?: string;
  HostMachineName?: string;
  RuntimeType?: string;
  InputArguments?: string;
  OutputArguments?: string;
}

// ─── Robot Log ─────────────────────────────────────────────────────
export interface UiPathRobotLog {
  Id: number;
  Level: string;
  WindowsIdentity?: string;
  ProcessName?: string;
  TimeStamp: string;
  Message: string;
  JobKey?: string;
  RobotName?: string;
  MachineId?: number;
  MachineName?: string;
  RuntimeType?: string;
}

// ─── Queue ─────────────────────────────────────────────────────────
export interface UiPathQueueDefinition {
  Id: number;
  Name: string;
  Description?: string;
  MaxNumberOfRetries?: number;
  AcceptAutomaticallyRetry?: boolean;
  EnforceUniqueReference?: boolean;
}

export interface UiPathQueueItem {
  Id: number;
  Key?: string;
  QueueDefinitionId: number;
  Status: string;
  ReviewStatus?: string;
  Reference?: string;
  Priority: string;
  DeferDate?: string;
  DueDate?: string;
  StartProcessing?: string;
  EndProcessing?: string;
  Progress?: string;
  SpecificContent?: Record<string, any>;
  Output?: Record<string, any>;
  AnalyticsData?: Record<string, any>;
  RetryNumber?: number;
  CreationTime: string;
  ProcessingExceptionType?: string;
  ProcessingException?: { Reason: string; Details?: string; Type?: string };
}

// ─── Release / Process ─────────────────────────────────────────────
export interface UiPathRelease {
  Id: number;
  Key: string;
  ProcessKey: string;
  ProcessVersion: string;
  Name: string;
  Description?: string;
  IsLatestVersion?: boolean;
  IsProcessDeleted?: boolean;
  InputArguments?: string;
  OrganizationUnitId?: number;
  OrganizationUnitFullyQualifiedName?: string;
  CurrentVersion?: { VersionNumber: string };
}

// ─── Asset ─────────────────────────────────────────────────────────
export interface UiPathAsset {
  Id: number;
  Name: string;
  ValueType: string;
  ValueScope: string;
  Value?: string;
  StringValue?: string;
  IntValue?: number;
  BoolValue?: boolean;
  CredentialUsername?: string;
  CredentialPassword?: string;
  KeyValueList?: Array<{ Key: string; Value: string }>;
}

// ─── Folder ────────────────────────────────────────────────────────
export interface UiPathFolder {
  Id: number;
  Key: string;
  DisplayName: string;
  FullyQualifiedName: string;
  ParentId?: number;
  IsPersonal?: boolean;
}

// ─── Stats ─────────────────────────────────────────────────────────
export interface UiPathJobsStats {
  Successful: number;
  Faulted: number;
  Stopped: number;
  Pending: number;
  Running: number;
  Suspended: number;
  Resumed: number;
}

export interface UiPathSessionsStats {
  Available: number;
  Busy: number;
  Disconnected: number;
  Unresponsive: number;
  Total: number;
}

export interface UiPathCountStats {
  Jobs: number;
  Robots: number;
  Processes: number;
  Queues: number;
  Schedules: number;
  Machines: number;
}

export interface UiPathLicenseStats {
  Attended: { Total: number; InUse: number };
  Unattended: { Total: number; InUse: number };
  NonProduction: { Total: number; InUse: number };
  Development: { Total: number; InUse: number };
}

// ─── Dashboard Snapshot ────────────────────────────────────────────
export interface DashboardSnapshot {
  timestamp: number;
  jobsStats: UiPathJobsStats;
  sessionsStats: UiPathSessionsStats;
  countStats: UiPathCountStats;
  licenseStats: UiPathLicenseStats | null;
  recentFaultedJobs: UiPathJob[];
  queueBacklog: Array<{ queueName: string; newItems: number; inProgress: number; failed: number }>;
  errorLogs24h: number;
}
