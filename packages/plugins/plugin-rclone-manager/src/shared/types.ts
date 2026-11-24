// SPDX-License-Identifier: Apache-2.0

import type { TRANSFER_OPERATIONS } from './constants';

export type RcloneTransferOperation = (typeof TRANSFER_OPERATIONS)[number];

export type RcloneAuthType = 'none' | 'basic';

export interface RcloneConnectionPublic {
  id: number;
  name: string;
  title?: string | null;
  baseUrl: string;
  authType: RcloneAuthType;
  username?: string | null;
  password?: string | null;
  enabled: boolean;
  checkUsageOnLoad: boolean;
  notes?: string | null;
  lastCheckAt?: string | null;
  lastVersion?: string | null;
  lastError?: string | null;
}

export interface RcloneUserPermissions {
  canAccess: boolean;
  canRead: boolean;
  canTransfer: boolean;
  canManageRemotes: boolean;
  canLocalFs: boolean;
  canMounts: boolean;
  canServes: boolean;
  canRawConfig: boolean;
  canManageConnections: boolean;
  canManage: boolean;
}

export interface RcloneVersionInfo {
  version?: string;
  os?: string;
  arch?: string;
  goVersion?: string;
  linking?: string;
  goTags?: string;
}

export interface RcloneTransferringItem {
  name?: string;
  size?: number;
  bytes?: number;
  percentage?: number;
  speed?: number;
  speedAvg?: number;
  eta?: number | null;
  group?: string;
  srcFs?: string;
  dstFs?: string;
}

export interface RcloneCoreStats {
  bytes?: number;
  totalBytes?: number;
  checks?: number;
  totalChecks?: number;
  deletes?: number;
  elapsedTime?: number;
  errors?: number;
  eta?: number | null;
  fatalError?: boolean;
  lastError?: string;
  renames?: number;
  retryError?: boolean;
  speed?: number;
  transferTime?: number;
  transfers?: number;
  totalTransfers?: number;
  transferring?: RcloneTransferringItem[];
  checking?: Array<{ name?: string; size?: number; group?: string }>;
}

export interface RcloneTransferredItem {
  name?: string;
  size?: number;
  bytes?: number;
  checked?: boolean;
  timestamp?: string;
  completed_at?: string;
  started_at?: string;
  error?: string;
  jobid?: number;
  group?: string;
  srcFs?: string;
  dstFs?: string;
}

export interface RcloneJobStatusResponse {
  id: number;
  duration?: number;
  endTime?: string;
  error?: string;
  executeId?: string;
  finished: boolean;
  group?: string;
  output?: unknown;
  startTime?: string;
  success: boolean;
}

export interface RcloneProviderOptionExample {
  Value: string;
  Help?: string;
  Provider?: string;
}

export interface RcloneProviderOption {
  Name: string;
  Help?: string;
  Provider?: string;
  Default?: unknown;
  DefaultStr?: string;
  Value?: unknown;
  ValueStr?: string;
  Examples?: RcloneProviderOptionExample[];
  Hide?: number;
  Required?: boolean;
  IsPassword?: boolean;
  NoPrefix?: boolean;
  Advanced?: boolean;
  Exclusive?: boolean;
  Sensitive?: boolean;
  Type?: string;
}

export interface RcloneProviderInfo {
  Name: string;
  Description?: string;
  Prefix?: string;
  Options?: RcloneProviderOption[];
  CommandHelp?: unknown[];
  Hide?: boolean;
}

export type RcloneFsLocality = 'local' | 'remote' | 'unknown';

export interface RcloneRemoteSummary {
  name: string;
  type: string;
  supportsAbout: boolean;
  isLocal?: boolean;
  locality?: RcloneFsLocality;
  bucketBased?: boolean;
  envDefined?: boolean;
}

export interface RcloneAboutUsage {
  total?: number;
  used?: number;
  trashed?: number;
  other?: number;
  free?: number;
  objects?: number;
}

export interface RcloneListItem {
  Path: string;
  Name: string;
  Size: number;
  MimeType?: string;
  ModTime?: string;
  IsDir: boolean;
  ID?: string;
}

export interface RcloneDiskInfo {
  fs?: string;
  path?: string;
  free?: number;
  total?: number;
  used?: number;
}

export interface RcloneMountPoint {
  Fs: string;
  MountPoint: string;
  MountedOn?: string;
  FsType?: string;
}

export interface RcloneServeItem {
  id: string;
  addr: string;
  params?: Record<string, unknown>;
}

export interface RcloneRuntimeOptionsSummary {
  transfers: number;
  checkers: number;
  bwLimit: string;
  tpsLimit: number;
  logLevel: string;
  logFile: string;
}

export type RcloneTransferTaskStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'unverified';

export interface RcloneTransferTaskRecord {
  id: number;
  title?: string | null;
  connectionId: number;
  operation: RcloneTransferOperation;
  srcFs: string;
  srcRemote?: string | null;
  dstFs: string;
  dstRemote?: string | null;
  createEmptySrcDirs?: boolean;
  deleteEmptySrcDirs?: boolean;
  dryRun?: boolean;
  filterRules?: Record<string, unknown> | null;
  extraConfig?: Record<string, unknown> | null;
  triggerSource: 'explorer' | 'workflow';
  localAuthorized?: boolean;
  status: RcloneTransferTaskStatus;
  rcloneJobId?: number | null;
  rcloneExecuteId?: string | null;
  rcloneGroup?: string | null;
  workflowId?: number | null;
  executionId?: number | null;
  workflowJobId?: string | null;
  workflowJobMeta?: RcloneWorkflowJobMeta | null;
  resumePending?: boolean;
  resumeToken?: string | null;
  resumeConsumedToken?: string | null;
  bytes?: number;
  totalBytes?: number;
  speed?: number;
  eta?: number | null;
  progress?: number;
  errorText?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  createdById?: number | null;
}

export interface RcloneTransferNodeConfig {
  connectionId?: number | string;
  taskId?: number | string;
  operation?: RcloneTransferOperation;
  srcFs?: string;
  srcRemote?: string;
  dstFs?: string;
  dstRemote?: string;
  createEmptySrcDirs?: boolean;
  deleteEmptySrcDirs?: boolean;
  dryRun?: boolean;
  filterInclude?: string;
  filterExclude?: string;
  failOnError?: boolean;
  allowLocalPaths?: boolean;
}

export interface RcloneWorkflowJobMeta {
  workflowJobId: string;
  workflowId?: number | null;
  executionId: number | string;
  nodeId: number | string;
  nodeKey: string;
  upstreamId?: number | string | null;
  failOnError: boolean;
  connectionId: number;
  operation: RcloneTransferOperation;
  srcFs: string;
  srcRemote: string;
  dstFs: string;
  dstRemote: string;
}

export interface RcloneTransferJobState {
  taskId: number;
  connectionId: number;
  rcloneJobId: number;
  rcloneExecuteId?: string | null;
  rcloneGroup?: string | null;
  resumeToken?: string | null;
  operation: RcloneTransferOperation;
  srcFs: string;
  srcRemote: string;
  dstFs: string;
  dstRemote: string;
  failOnError: boolean;
  success?: boolean;
  bytes?: number;
  totalBytes?: number;
  duration?: number;
  error?: string;
}
