/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { SECRET_MASK } from './constants';
import type { ConfigurableEnvItem, EnvMergeStrategy, PortainerEnvPair } from './types';

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_ENV_KEY_PATTERN = /(password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)/i;

export function isValidEnvKey(key: string): boolean {
  return ENV_KEY_PATTERN.test(key.trim());
}

export function isLikelySensitiveKey(key: string): boolean {
  return SENSITIVE_ENV_KEY_PATTERN.test(key);
}

function stripMatchingQuotes(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

export function stringifyEnvValue(value: unknown): string {
  if (value === null || typeof value === 'undefined') {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Parse multi-line `.env` content (`KEY=VALUE` or `export KEY=VALUE`) into ordered pairs.
 */
export function parseDotEnvText(text?: string | null): PortainerEnvPair[] {
  if (!text || typeof text !== 'string') {
    return [];
  }
  const result: PortainerEnvPair[] = [];
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eqIndex = normalized.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const name = normalized.slice(0, eqIndex).trim();
    if (!isValidEnvKey(name)) {
      continue;
    }
    const rawVal = normalized.slice(eqIndex + 1).trim();
    result.push({
      name,
      value: stripMatchingQuotes(rawVal),
    });
  }
  return result;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize dynamic workflow env input from an array (`[{ name, value }]`), record (`{ KEY: val }`),
 * JSON string, or `.env` text fallback.
 */
export function parseDynamicEnvInput(input: unknown): PortainerEnvPair[] {
  if (input === null || typeof input === 'undefined' || input === '') {
    return [];
  }

  let resolved: unknown = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      return [];
    }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        resolved = JSON.parse(trimmed);
      } catch {
        throw new Error('Dynamic environment JSON is invalid');
      }
    } else {
      return parseDotEnvText(trimmed);
    }
  }

  if (Array.isArray(resolved)) {
    const pairs: PortainerEnvPair[] = [];
    for (const item of resolved) {
      if (!isPlainRecord(item)) {
        continue;
      }
      const rawName = typeof item.name === 'string' ? item.name : typeof item.key === 'string' ? item.key : '';
      const name = rawName.trim();
      if (!name || !isValidEnvKey(name)) {
        continue;
      }
      pairs.push({
        name,
        value: stringifyEnvValue(item.value),
      });
    }
    return pairs;
  }

  if (isPlainRecord(resolved)) {
    const pairs: PortainerEnvPair[] = [];
    for (const [rawKey, val] of Object.entries(resolved)) {
      const name = rawKey.trim();
      if (!name || !isValidEnvKey(name)) {
        continue;
      }
      pairs.push({
        name,
        value: stringifyEnvValue(val),
      });
    }
    return pairs;
  }

  return [];
}

export interface MergedEnvResult {
  env: PortainerEnvPair[];
  maskedEnv: Record<string, string>;
  secretKeys: string[];
}

/**
 * Deterministically build the final Portainer Stack `env` array and a redacted view for logs/job outputs.
 * Precedence: existing Stack.Env (when strategy === 'merge') -> dynamicEnv -> envText -> envPairs.
 */
export function buildEffectiveStackEnv(options: {
  existingEnv?: PortainerEnvPair[];
  strategy?: EnvMergeStrategy;
  dynamicEnv?: unknown;
  envText?: string | null;
  envPairs?: ConfigurableEnvItem[];
}): MergedEnvResult {
  const map = new Map<string, string>();
  const explicitSecrets = new Set<string>();

  if ((options.strategy ?? 'merge') === 'merge' && Array.isArray(options.existingEnv)) {
    for (const item of options.existingEnv) {
      const name = String(item?.name ?? '').trim();
      if (name) {
        map.set(name, stringifyEnvValue(item.value));
      }
    }
  }

  for (const item of parseDynamicEnvInput(options.dynamicEnv)) {
    map.set(item.name, item.value);
  }

  for (const item of parseDotEnvText(options.envText)) {
    map.set(item.name, item.value);
  }

  if (Array.isArray(options.envPairs)) {
    for (const item of options.envPairs) {
      const name = String(item?.name ?? '').trim();
      if (!name) {
        continue;
      }
      if (!isValidEnvKey(name)) {
        throw new Error(`Invalid environment variable name "${name}"`);
      }
      map.set(name, stringifyEnvValue(item.value));
      if (item.secret) {
        explicitSecrets.add(name);
      }
    }
  }

  const env: PortainerEnvPair[] = [];
  const maskedEnv: Record<string, string> = {};
  const secretKeys: string[] = [];

  for (const [name, value] of map.entries()) {
    env.push({ name, value });
    const shouldMask = explicitSecrets.has(name) || isLikelySensitiveKey(name);
    if (shouldMask) {
      secretKeys.push(name);
      maskedEnv[name] = SECRET_MASK;
    } else {
      maskedEnv[name] = value;
    }
  }

  return { env, maskedEnv, secretKeys };
}

export function normalizeGitReference(ref?: string | null, fallback?: string | null): string {
  const raw = String(ref ?? '').trim();
  if (!raw) {
    const fb = String(fallback ?? '').trim();
    return fb || 'refs/heads/main';
  }
  if (raw.startsWith('refs/')) {
    return raw;
  }
  return `refs/heads/${raw}`;
}
