/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  JOURNAL_SCHEMA_VERSION,
  LIFECYCLE_PHASES,
  POLICY_SCHEMA_VERSION,
  type ApprovedPolicyRule,
  type GuardianPolicy,
  type StartupIncident,
} from './contracts';
import { getStateDirectory, readRetryRequest, readState, writeRetryRequest } from './journal';
import { isPotentialSharedInfrastructureFailure, randomId } from './security';
import { writeJsonFileAtomic } from './storage';
import { getProcessLockIdentity, withLocalLock } from './local-lock';

export const BUILT_IN_PROTECTED_PACKAGES = [
  'plugin-startup-guardian',
  '@nocobase/server',
  '@nocobase/database',
  '@nocobase/auth',
  '@nocobase/acl',
  '@nocobase/plugin-auth',
  '@nocobase/plugin-acl',
  '@nocobase/plugin-users',
  '@nocobase/plugin-system-settings',
  'plugin-cluster-manager',
  'plugin-ha-scheduler',
];

const NON_QUARANTINABLE_COORDINATION_PACKAGES = new Set(['plugin-cluster-manager', 'plugin-ha-scheduler']);

export function createDefaultPolicy(): GuardianPolicy {
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    revision: 0,
    autoRecoveryEnabled: false,
    protectedPackages: [...BUILT_IN_PROTECTED_PACKAGES],
    approvedRules: [],
  };
}

export function getPolicyPath(stateDirectory = getStateDirectory()): string {
  return join(stateDirectory, 'policy.json');
}

export async function readPolicy(stateDirectory = getStateDirectory()): Promise<GuardianPolicy> {
  try {
    const raw = await readFile(getPolicyPath(stateDirectory), 'utf8');
    const value: unknown = JSON.parse(raw);
    if (!isGuardianPolicy(value)) throw new Error('Startup Guardian policy has an unsupported or invalid schema');
    return value;
  } catch (error) {
    if (isMissingFileError(error)) return createDefaultPolicy();
    throw error;
  }
}

export async function writePolicy(policy: GuardianPolicy, stateDirectory = getStateDirectory()): Promise<void> {
  if (!isGuardianPolicy(policy)) throw new Error('Invalid Startup Guardian policy');
  await withLocalLock(stateDirectory, 'policy-write.lock', getProcessLockIdentity(), () =>
    writePolicyUnlocked(policy, stateDirectory),
  );
}

export async function addApprovedRule(
  incident: StartupIncident,
  approvedBy: string,
  stateDirectory = getStateDirectory(),
): Promise<GuardianPolicy> {
  return withLocalLock(stateDirectory, 'policy-write.lock', getProcessLockIdentity(), async () => {
    const current = await readPolicy(stateDirectory);
    const next = approveIncidentInPolicy(current, incident, approvedBy);
    if (next === current) return current;
    await writePolicyUnlocked(next, stateDirectory);
    return next;
  });
}

export function approveIncidentInPolicy(
  current: GuardianPolicy,
  incident: StartupIncident,
  approvedBy: string,
): GuardianPolicy {
  if (isProtectedPackage(incident.packageName, current)) throw new Error('Protected packages cannot be approved');
  if (current.approvedRules.some((rule) => ruleMatchesIncident(rule, incident))) return current;
  const rule: ApprovedPolicyRule = {
    pluginName: incident.pluginName,
    packageName: incident.packageName,
    pluginVersion: incident.pluginVersion,
    phase: incident.phase,
    fingerprint: incident.fingerprint,
    approvedBy: approvedBy.trim().slice(0, 120) || 'operator',
    approvedAt: new Date().toISOString(),
  };
  return { ...current, revision: current.revision + 1, approvedRules: [...current.approvedRules, rule] };
}

export async function setAutoRecoveryEnabled(
  enabled: boolean,
  stateDirectory = getStateDirectory(),
): Promise<GuardianPolicy> {
  return withLocalLock(stateDirectory, 'policy-write.lock', getProcessLockIdentity(), async () => {
    const current = await readPolicy(stateDirectory);
    if (current.autoRecoveryEnabled === enabled) return current;
    const next = setAutoRecoveryInPolicy(current, enabled);
    await writePolicyUnlocked(next, stateDirectory);
    return next;
  });
}

export function setAutoRecoveryInPolicy(current: GuardianPolicy, enabled: boolean): GuardianPolicy {
  if (current.autoRecoveryEnabled === enabled) return current;
  return { ...current, revision: current.revision + 1, autoRecoveryEnabled: enabled };
}

export function isProtectedPackage(packageName: string, policy: GuardianPolicy): boolean {
  return (
    packageName.startsWith('@nocobase/') ||
    NON_QUARANTINABLE_COORDINATION_PACKAGES.has(packageName.toLowerCase()) ||
    policy.protectedPackages.some((protectedPackage) => protectedPackage.toLowerCase() === packageName.toLowerCase())
  );
}

export function ruleMatchesIncident(rule: ApprovedPolicyRule, incident: StartupIncident): boolean {
  return (
    rule.pluginName === incident.pluginName &&
    rule.packageName === incident.packageName &&
    rule.pluginVersion === incident.pluginVersion &&
    rule.phase === incident.phase &&
    rule.fingerprint === incident.fingerprint
  );
}

export function isApprovedIncident(policy: GuardianPolicy, incident: StartupIncident): boolean {
  return (
    policy.autoRecoveryEnabled &&
    !isProtectedPackage(incident.packageName, policy) &&
    !isPotentialSharedInfrastructureFailure(incident) &&
    policy.approvedRules.some((rule) => ruleMatchesIncident(rule, incident))
  );
}

export function isValidApprovalInput(value: {
  packageName: string;
  pluginName: string;
  pluginVersion: string;
  phase: string;
  fingerprint: string;
}): value is {
  packageName: string;
  pluginName: string;
  pluginVersion: string;
  phase: (typeof LIFECYCLE_PHASES)[number];
  fingerprint: string;
} {
  return (
    /^[a-z0-9][a-z0-9._-]*$/i.test(value.packageName) &&
    /^[a-z0-9][a-z0-9._-]*$/i.test(value.pluginName) &&
    value.pluginVersion.length > 0 &&
    LIFECYCLE_PHASES.includes(value.phase as (typeof LIFECYCLE_PHASES)[number]) &&
    /^[a-f0-9]{64}$/i.test(value.fingerprint)
  );
}

export async function requestRetry(
  input: { packageName: string; expectedRevision: number; requestedBy: string },
  stateDirectory = getStateDirectory(),
) {
  return withLocalLock(stateDirectory, 'state-write.lock', getProcessLockIdentity(), async () => {
    const state = await readState(stateDirectory);
    if (
      !state ||
      state.revision !== input.expectedRevision ||
      !state.quarantine ||
      state.quarantine.status !== 'quarantined'
    ) {
      throw new Error('Startup Guardian state changed; refresh before retrying');
    }
    if (state.quarantine.incident.packageName !== input.packageName) {
      throw new Error('Retry package does not match quarantine');
    }
    if (await readRetryRequest(stateDirectory)) throw new Error('A retry request is already pending');
    const request = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      requestId: randomId(),
      packageName: input.packageName,
      expectedRevision: input.expectedRevision,
      requestedBy: input.requestedBy.trim().slice(0, 120) || 'operator',
      requestedAt: new Date().toISOString(),
    } as const;
    await writeRetryRequest(request, stateDirectory);
    return request;
  });
}

async function writePolicyUnlocked(policy: GuardianPolicy, stateDirectory: string): Promise<void> {
  await writeJsonFileAtomic(getPolicyPath(stateDirectory), policy);
}

export function isGuardianPolicy(value: unknown): value is GuardianPolicy {
  if (!value || typeof value !== 'object') return false;
  const policy = value as Partial<GuardianPolicy>;
  if (
    policy.schemaVersion !== POLICY_SCHEMA_VERSION ||
    typeof policy.revision !== 'number' ||
    typeof policy.autoRecoveryEnabled !== 'boolean' ||
    !Array.isArray(policy.protectedPackages) ||
    !Array.isArray(policy.approvedRules)
  ) {
    return false;
  }
  if (policy.protectedPackages.some((name) => typeof name !== 'string')) return false;
  return policy.approvedRules.every(isApprovedPolicyRule);
}

function isApprovedPolicyRule(value: unknown): value is ApprovedPolicyRule {
  if (!value || typeof value !== 'object') return false;
  const rule = value as Partial<ApprovedPolicyRule>;
  return (
    typeof rule.pluginName === 'string' &&
    typeof rule.packageName === 'string' &&
    typeof rule.pluginVersion === 'string' &&
    typeof rule.phase === 'string' &&
    LIFECYCLE_PHASES.includes(rule.phase as (typeof LIFECYCLE_PHASES)[number]) &&
    typeof rule.fingerprint === 'string' &&
    /^[a-f0-9]{64}$/i.test(rule.fingerprint) &&
    typeof rule.approvedBy === 'string' &&
    typeof rule.approvedAt === 'string'
  );
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
