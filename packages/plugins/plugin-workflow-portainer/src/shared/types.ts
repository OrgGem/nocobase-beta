/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export type ID = string | number;

export interface PortainerEnvPair {
  name: string;
  value: string;
}

export interface ConfigurableEnvItem {
  name?: string;
  value?: unknown;
  secret?: boolean;
}

export type RedeployTargetMode = 'stack' | 'webhook';
export type EnvMergeStrategy = 'merge' | 'replace';
export type StackControlAction = 'inspect' | 'start' | 'stop';

export interface PortainerStackRedeployConfig {
  instanceId?: ID | string | null;
  mode?: RedeployTargetMode;
  endpointId?: ID | string | null;
  stackId?: ID | string | null;
  webhookId?: string | null;
  webhookTag?: string | null;
  gitReference?: string | null;
  repullImage?: boolean;
  prune?: boolean;
  envStrategy?: EnvMergeStrategy;
  dynamicEnv?: unknown;
  envText?: string | null;
  envPairs?: ConfigurableEnvItem[];
  timeoutMs?: number;
  ignoreFail?: boolean;
}

export interface PortainerStackControlConfig {
  instanceId?: ID | string | null;
  endpointId?: ID | string | null;
  stackId?: ID | string | null;
  action?: StackControlAction;
  timeoutMs?: number;
  ignoreFail?: boolean;
}

export interface PortainerEndpointSummary {
  id: number;
  name: string;
  type: number;
  status: number;
  url?: string;
}

export interface PortainerStackSummary {
  id: number;
  name: string;
  endpointId: number;
  type: number;
  status: number;
  isGitStack: boolean;
  gitRepoUrl?: string;
  gitReference?: string;
  envCount: number;
}

export interface PortainerDeploymentRecord {
  status: number;
  time?: number;
  message?: string;
}

export interface PortainerStackDetail extends PortainerStackSummary {
  env: PortainerEnvPair[];
  hasSavedGitCredential: boolean;
  gitCredentialId: number;
  gitUsername?: string;
  entryPoint?: string;
  projectPath?: string;
  createdAt?: number;
  createdBy?: string;
  updatedAt?: number;
  updatedBy?: string;
  gitConfigFilePath?: string;
  gitCommitHash?: string;
  deployments?: PortainerDeploymentRecord[];
}

export interface PortainerContainerStats {
  cpuPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
  memPercent: number;
  netRxBytes: number;
  netTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
}

export interface PortainerContainerSummary {
  id: string;
  name: string;
  service?: string;
  image: string;
  state: string;
  status: string;
  healthy: boolean;
  created?: number;
  ports?: string[];
  ipAddresses?: string[];
  stats?: PortainerContainerStats | null;
}

export interface PortainerStackOverviewSummary {
  totalCount: number;
  runningCount: number;
  healthy: boolean;
  totalCpuPercent: number;
  totalMemUsageBytes: number;
  memLimitBytes: number;
  totalMemPercent: number;
  totalNetRxBytes: number;
  totalNetTxBytes: number;
}

export interface PortainerMaskedEnvItem {
  name: string;
  value: string;
  hasExistingValue: boolean;
  sensitive: boolean;
}

export interface PortainerStackOverview {
  detail: Omit<PortainerStackDetail, 'env'> & { env: PortainerMaskedEnvItem[] };
  stackFileContent: string;
  containers: PortainerContainerSummary[];
  summary: PortainerStackOverviewSummary;
  sampledAt: string;
}

export interface PortainerInstanceSummary {
  id: number;
  name: string;
  baseUrl: string;
  apiKey?: string;
  gitUsername?: string;
  gitAccessToken?: string;
  gitCredentialId?: number | null;
  allowInsecureTls?: boolean;
  defaultTimeoutMs?: number;
  isDefault?: boolean;
  enabled?: boolean;
  lastHealthStatus?: string | null;
  lastVersion?: string | null;
  lastCheckedAt?: string | null;
}
