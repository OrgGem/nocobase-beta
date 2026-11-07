/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { LifecyclePhase, StartupIncident } from './contracts';

const SENSITIVE_VALUE_PATTERNS = [
  /(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi,
  /(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
  /((?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*)[^\s,;&]+/gi,
  /(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi,
];

export function randomId(): string {
  return randomUUID();
}

export function redactText(value: string): string {
  let result = value.replace(/[\r\n\t]+/g, ' ').trim();
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    result = result.replace(pattern, '$1[redacted]');
  }
  return result.slice(0, 1000);
}

export function errorSummary(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: redactText(error.name || 'Error').slice(0, 120),
      message: redactText(error.message || 'Unknown error'),
    };
  }

  return { name: 'Error', message: redactText(String(error)) };
}

export function isPotentialSharedInfrastructureFailure(input: { errorName: string; errorMessage: string }): boolean {
  const text = `${input.errorName} ${input.errorMessage}`;
  return [
    /\b(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE)\b/i,
    /\b(?:SequelizeConnectionError|SequelizeHostNotFoundError|SequelizeHostNotReachableError|SequelizeConnectionRefusedError|ConnectionRefusedError|ConnectionTimeoutError)\b/i,
    /\b(?:postgres(?:ql)?|mysql|mariadb|sqlite|redis|database)\b.{0,60}\b(?:connection|connect|timeout|refused|unavailable|closed|reset|busy)\b/i,
    /\b(?:connection|connect|socket|network|dns|timeout)\b.{0,60}\b(?:database|postgres(?:ql)?|mysql|mariadb|redis|host|refused|unavailable|reset|timed out)\b/i,
  ].some((pattern) => pattern.test(text));
}

export function createFingerprint(input: {
  pluginName: string;
  packageName: string;
  pluginVersion: string;
  phase: LifecyclePhase;
  errorName: string;
  errorMessage: string;
}): string {
  const normalized = [
    input.pluginName,
    input.packageName,
    input.pluginVersion,
    input.phase,
    input.errorName,
    input.errorMessage,
  ].join('\n');
  return createHash('sha256').update(normalized).digest('hex');
}

export function isStartupIncident(value: unknown): value is StartupIncident {
  if (!value || typeof value !== 'object') return false;
  const incident = value as Partial<StartupIncident>;
  return (
    incident.schemaVersion === 1 &&
    incident.eventType === 'lifecycle-failure' &&
    typeof incident.eventId === 'string' &&
    typeof incident.appId === 'string' &&
    typeof incident.deploymentId === 'string' &&
    typeof incident.bootId === 'string' &&
    typeof incident.timestamp === 'string' &&
    typeof incident.pluginName === 'string' &&
    typeof incident.packageName === 'string' &&
    typeof incident.pluginVersion === 'string' &&
    typeof incident.phase === 'string' &&
    typeof incident.errorName === 'string' &&
    typeof incident.errorMessage === 'string' &&
    typeof incident.fingerprint === 'string' &&
    /^[a-f0-9]{64}$/.test(incident.fingerprint)
  );
}
