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

export interface PortainerStackDetail extends PortainerStackSummary {
  env: PortainerEnvPair[];
  hasSavedGitCredential: boolean;
  gitCredentialId: number;
  gitUsername?: string;
}

export interface PortainerContainerSummary {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  healthy: boolean;
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
