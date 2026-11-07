/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export const JOURNAL_SCHEMA_VERSION = 1 as const;
export const POLICY_SCHEMA_VERSION = 1 as const;
export const CLUSTER_RECOVERY_PROTOCOL_VERSION = 1 as const;

export const LIFECYCLE_PHASES = ['beforeLoad', 'loadCollections', 'loadAI', 'load'] as const;
export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];

export interface StartupIncident {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  eventId: string;
  eventType: 'lifecycle-failure';
  appId: string;
  deploymentId: string;
  bootId: string;
  timestamp: string;
  pluginName: string;
  packageName: string;
  pluginVersion: string;
  phase: LifecyclePhase;
  errorName: string;
  errorMessage: string;
  fingerprint: string;
}

export interface ApprovedPolicyRule {
  pluginName: string;
  packageName: string;
  pluginVersion: string;
  phase: LifecyclePhase;
  fingerprint: string;
  approvedBy: string;
  approvedAt: string;
}

export interface GuardianPolicy {
  schemaVersion: typeof POLICY_SCHEMA_VERSION;
  revision: number;
  autoRecoveryEnabled: boolean;
  protectedPackages: string[];
  approvedRules: ApprovedPolicyRule[];
}

export type GuardianStatus = 'stopped' | 'starting' | 'ready' | 'recovery-required';

export type QuarantineStatus =
  | 'quarantined'
  | 'retry-pending'
  | 'retrying'
  | 're-quarantined'
  | 'cleared'
  | 'retry-failed';

export interface QuarantineReceipt {
  quarantineId: string;
  status: QuarantineStatus;
  incident: StartupIncident;
  target: QuarantineTarget;
  rowId: string | number;
  postUpdateTimestamp: string;
  retryEnabledTimestamp?: string;
  prior: {
    enabled: boolean;
    installed: boolean;
    builtIn: boolean;
    version: string;
    options: unknown;
    updatedAt: string;
  };
  quarantinedAt: string;
}

export interface RetryRequest {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  requestId: string;
  packageName: string;
  expectedRevision: number;
  requestedBy: string;
  requestedAt: string;
}

export interface GuardianState {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  revision: number;
  campaignId: string;
  appId: string;
  deploymentId: string;
  state: GuardianStatus;
  bootId?: string;
  incident?: StartupIncident;
  quarantine?: QuarantineReceipt;
  quarantinePending?: {
    incident: StartupIncident;
    target: QuarantineTarget;
    attempt: number;
    prior: QuarantineReceipt['prior'];
    rowId: string | number;
  };
  quarantineAttempts: number;
  maxQuarantineAttempts: number;
  updatedAt: string;
  readyAt?: string;
  retryRequest?: RetryRequest;
  detail?: string;
}

export type ClusterRecoveryPhase = 'ready' | 'draining' | 'restarting' | 'recovery-required';
export type ClusterMemberState = 'never-started' | 'starting' | 'ready' | 'draining' | 'stopped' | 'recovery-required';

export interface ClusterMemberIdentity {
  nodeId: string;
  bootId: string;
}

export interface ClusterDrainDecision {
  type: 'quarantine' | 'retry';
  revision: number;
  policyRevision: number;
  requestedAt: string;
  incident?: StartupIncident;
  target: QuarantineTarget;
  participants: ClusterMemberIdentity[];
  requestedBy?: string;
}

export interface ClusterRetryRequest {
  requestId: string;
  packageName: string;
  expectedDecisionRevision: number;
  requestedBy: string;
  requestedAt: string;
}

export interface SharedClusterControl {
  appId: string;
  deploymentId: string;
  revision: number;
  fence: number;
  drainRevision: number;
  decisionRevision: number;
  policyRevision: number;
  ownerToken: string | null;
  ownerNodeId: string | null;
  ownerLeaseExpiresAt: string | null;
  phase: ClusterRecoveryPhase;
  expectedMembers: string[];
  policy: GuardianPolicy;
  campaignId: string;
  quarantineAttempts: number;
  maxQuarantineAttempts: number;
  pendingDecision?: ClusterDrainDecision;
  quarantine?: QuarantineReceipt;
  retryRequest?: ClusterRetryRequest;
  incident?: StartupIncident;
  detail?: string;
}

export interface SharedClusterMember {
  appId: string;
  deploymentId: string;
  nodeId: string;
  bootId: string | null;
  coreVersion: string | null;
  protocolVersion: number;
  state: ClusterMemberState;
  acknowledgedRevision: number;
  appliedRevision: number;
  lastHeartbeatAt: string | null;
  incident?: StartupIncident;
}

export interface ClusterRecoveryAuthority {
  ownerToken: string;
  ownerNodeId: string;
  fence: number;
}

export interface QuarantineTarget {
  pluginName: string;
  packageName: string;
  pluginVersion: string;
}

export interface QuarantineResult {
  changed: boolean;
  target: QuarantineTarget;
  rowId: string | number;
  postUpdateTimestamp: string;
  priorUpdatedAt: string;
  before: {
    enabled: boolean;
    version: string;
    installed: boolean;
    builtIn: boolean;
    options: unknown;
    updatedAt: string;
  };
}
