import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { normalizeWorkerMode } from '../../shared/worker-processes';
import type { StackConfig } from './types';

export type WorkerTemplateScope = 'global' | 'stack';

export interface WorkerTemplateVariable {
  id?: number;
  key: string;
  value?: string | null;
  secretValue?: string | null;
  valueType?: 'string' | 'number' | 'boolean' | 'json' | 'secret';
  category?: string;
  scope: WorkerTemplateScope;
  stackId?: number | null;
  description?: string | null;
  defaultValue?: string | null;
  required?: boolean;
  systemManaged?: boolean;
  overridable?: boolean;
  secret?: boolean;
  enabled?: boolean;
  sort?: number;
}

export interface WorkerTemplateResolution {
  envVars: Record<string, string>;
  image?: string;
  templateHash: string;
  warnings: string[];
  sources: Record<string, string>;
}

export const WORKER_TEMPLATE_DEFAULTS: ReadonlyArray<Omit<WorkerTemplateVariable, 'id'>> = [
  {
    key: 'APP_ROLE',
    value: 'worker',
    valueType: 'string',
    category: 'identity',
    scope: 'global',
    description: 'Node classification enforced by Cluster Manager.',
    systemManaged: true,
    overridable: false,
    enabled: true,
    sort: 10,
  },
  {
    key: 'APP_NODE_ROLE',
    value: 'worker',
    valueType: 'string',
    category: 'identity',
    scope: 'global',
    description: 'Selects the worker bootstrap branch and prevents migration commands.',
    systemManaged: true,
    overridable: false,
    enabled: true,
    sort: 20,
  },
  {
    key: 'WORKER_MODE',
    value: '*',
    valueType: 'string',
    category: 'runtime',
    scope: 'global',
    description: 'Default worker queue mode. A stack workerMode can narrow this value.',
    systemManaged: true,
    overridable: true,
    enabled: true,
    sort: 30,
  },
  {
    key: 'WORKER_READY_URL',
    value: '',
    valueType: 'string',
    category: 'readiness',
    scope: 'global',
    description: 'Readiness endpoint for the migration leader. Empty falls back to CLUSTER_MANAGER_WORKER_READY_URL.',
    required: true,
    enabled: true,
    sort: 40,
  },
  {
    key: 'WORKER_READY_TIMEOUT_SECONDS',
    value: '900',
    valueType: 'number',
    category: 'readiness',
    scope: 'global',
    enabled: true,
    sort: 50,
  },
  {
    key: 'WORKER_READY_INTERVAL_SECONDS',
    value: '5',
    valueType: 'number',
    category: 'readiness',
    scope: 'global',
    enabled: true,
    sort: 60,
  },
  {
    key: 'WORKER_READY_GRACE_SECONDS',
    value: '15',
    valueType: 'number',
    category: 'readiness',
    scope: 'global',
    enabled: true,
    sort: 70,
  },
  {
    key: 'APP_PORT',
    value: '13000',
    valueType: 'number',
    category: 'runtime',
    scope: 'global',
    enabled: true,
    sort: 80,
  },
  {
    key: 'SKILL_HUB_SANDBOX',
    value: 'false',
    valueType: 'boolean',
    category: 'runtime',
    scope: 'global',
    enabled: true,
    sort: 90,
  },
  {
    key: 'WORKER_IMAGE',
    value: '',
    valueType: 'string',
    category: 'runtime',
    scope: 'global',
    description: 'Optional explicit worker image. Empty inherits the running app image for Docker.',
    enabled: true,
    sort: 100,
  },
];

const ENFORCED_KEYS = new Set(['APP_ROLE', 'APP_NODE_ROLE', 'LOGGER_BASE_PATH']);
const FORBIDDEN_STACK_OVERRIDE_KEYS = new Set(['APP_ROLE', 'APP_NODE_ROLE']);
const ENVIRONMENT_KEY = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_PREFIX = 'cmv1';

function getSecretKey(): Buffer {
  const configured = process.env.ENCRYPTION_FIELD_KEY;
  if (!configured) {
    throw new Error('ENCRYPTION_FIELD_KEY is required to use secret worker template variables');
  }
  return createHash('sha256').update(configured).digest();
}

export function encryptWorkerTemplateSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getSecretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [SECRET_PREFIX, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join(
    '.',
  );
}

export function decryptWorkerTemplateSecret(value: string): string {
  const [prefix, iv, tag, encrypted] = value.split('.');
  // Compatibility with unencrypted rows created by an earlier prerelease.
  if (prefix !== SECRET_PREFIX || !iv || !tag || !encrypted) {
    return value;
  }
  const decipher = createDecipheriv('aes-256-gcm', getSecretKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
}

export function isWorkerTemplateEnvironmentKey(key: string): boolean {
  return ENVIRONMENT_KEY.test(key);
}

export function isForbiddenWorkerTemplateOverride(key: string, scope: WorkerTemplateScope): boolean {
  return ENFORCED_KEYS.has(key) || (scope === 'stack' && FORBIDDEN_STACK_OVERRIDE_KEYS.has(key));
}

export function maskWorkerTemplateVariable(
  variable: WorkerTemplateVariable,
): WorkerTemplateVariable & { masked?: boolean } {
  if (!variable.secret) {
    return { ...variable, secretValue: undefined };
  }
  return {
    ...variable,
    value: variable.secretValue ? '••••••••' : '',
    secretValue: undefined,
    masked: Boolean(variable.secretValue),
  };
}

function valueOf(variable: WorkerTemplateVariable): string {
  const value = variable.secret ? variable.secretValue : variable.value;
  if (value == null) return '';
  return variable.secret ? decryptWorkerTemplateSecret(String(value)) : String(value);
}

function applyVariables(
  target: Record<string, string>,
  sources: Record<string, string>,
  variables: WorkerTemplateVariable[],
  source: string,
) {
  for (const variable of variables) {
    if (
      !variable.enabled ||
      !isWorkerTemplateEnvironmentKey(variable.key) ||
      isForbiddenWorkerTemplateOverride(variable.key, variable.scope)
    ) {
      continue;
    }
    target[variable.key] = valueOf(variable);
    sources[variable.key] = source;
  }
}

/**
 * Resolves a worker config without assuming a particular Compose service name.
 * The adapter supplies inherited app values; collection rows then take precedence.
 */
export function resolveWorkerTemplate(input: {
  stack: StackConfig;
  variables: WorkerTemplateVariable[];
  inheritedEnv?: Record<string, string | undefined>;
  inheritedImage?: string;
  fallbackReadyUrl?: string;
}): WorkerTemplateResolution {
  const { stack, variables, inheritedEnv = {}, inheritedImage, fallbackReadyUrl } = input;
  const envVars: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const warnings: string[] = [];

  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (value !== undefined && isWorkerTemplateEnvironmentKey(key)) {
      envVars[key] = value;
      sources[key] = 'inherited-app';
    }
  }

  const enabledVariables = variables.filter((variable) => variable.enabled !== false);
  const global = enabledVariables
    .filter((variable) => variable.scope === 'global')
    .sort((left, right) => (left.sort || 0) - (right.sort || 0));
  const stackVariables = enabledVariables
    .filter((variable) => variable.scope === 'stack' && String(variable.stackId) === String(stack.id))
    .sort((left, right) => (left.sort || 0) - (right.sort || 0));
  applyVariables(envVars, sources, global, 'global-template');

  const configuredKeys = new Set([...global, ...stackVariables].map((variable) => variable.key));
  for (const [key, value] of Object.entries(stack.envVars || {})) {
    if (
      !configuredKeys.has(key) &&
      !isForbiddenWorkerTemplateOverride(key, 'stack') &&
      isWorkerTemplateEnvironmentKey(key)
    ) {
      envVars[key] = String(value);
      sources[key] = 'legacy-stack-env';
    }
  }
  applyVariables(envVars, sources, stackVariables, 'stack-template');

  const workerMode = normalizeWorkerMode(stack.workerMode || envVars.WORKER_MODE) || '*';
  const readyUrl = envVars.WORKER_READY_URL || envVars.CLUSTER_MANAGER_WORKER_READY_URL || fallbackReadyUrl;
  if (!readyUrl) {
    throw new Error(
      `Worker stack "${stack.name}" has no readiness URL. Set WORKER_READY_URL or CLUSTER_MANAGER_WORKER_READY_URL before scaling.`,
    );
  }

  if (stack.image?.trim()) {
    warnings.push(
      `Stack image "${stack.image}" is ignored. Configure WORKER_IMAGE or inherit the running app image to avoid version drift.`,
    );
  }
  if (stack.command?.trim()) {
    warnings.push(
      'Stack command is ignored. Workers use the managed worker bootstrap and cannot run migration commands.',
    );
  }

  const image = envVars.WORKER_IMAGE?.trim() || envVars.CLUSTER_MANAGER_WORKER_IMAGE?.trim() || inheritedImage?.trim();
  delete envVars.WORKER_IMAGE;
  delete sources.WORKER_IMAGE;
  envVars.WORKER_READY_URL = readyUrl;
  envVars.APP_ROLE = 'worker';
  envVars.APP_NODE_ROLE = 'worker';
  envVars.WORKER_MODE = workerMode;
  envVars.LOGGER_BASE_PATH = `/app/nocobase/storage/logs/${stack.name}`;
  sources.APP_ROLE = 'enforced';
  sources.APP_NODE_ROLE = 'enforced';
  sources.WORKER_MODE = 'enforced';
  sources.WORKER_READY_URL = sources.WORKER_READY_URL || 'deployment-fallback';
  sources.LOGGER_BASE_PATH = 'enforced';

  const hashInput = JSON.stringify({
    envVars: Object.entries(envVars).sort(([left], [right]) => left.localeCompare(right)),
    image,
  });
  const templateHash = createHash('sha256').update(hashInput).digest('hex').slice(0, 16);
  envVars.WORKER_TEMPLATE_HASH = templateHash;
  sources.WORKER_TEMPLATE_HASH = 'generated';

  return { envVars, image, templateHash, warnings, sources };
}
