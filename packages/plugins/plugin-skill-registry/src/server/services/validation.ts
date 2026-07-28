import { RegistryError } from '../contracts/errors';
import { isRecord } from '../contracts/types';

const IDENTITY_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CHANNEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SOURCE_MUTABLE_FIELDS = new Set([
  'name',
  'providerType',
  'namespace',
  'providerConfig',
  'enabled',
  'syncPolicy',
  'syncIntervalMinutes',
]);
const GIT_CONFIG_FIELDS = new Set(['repositoryId', 'ref', 'rootPath']);
const SKILL_HUB_CONFIG_FIELDS = new Set(['skillDefinitionIds']);
const CREDENTIAL_KEYS = new Set([
  'accesstoken',
  'accesskey',
  'apikey',
  'authorization',
  'credential',
  'credentials',
  'password',
  'pat',
  'privatekey',
  'secret',
  'token',
]);
const CREDENTIAL_KEY_FRAGMENTS = [
  'apikey',
  'accesskey',
  'authorization',
  'credential',
  'password',
  'privatekey',
  'secret',
  'token',
];
const SELF_GRANT_KEYS = new Set([
  'allowregistryexport',
  'exportenabled',
  'registryexportenabled',
  'registryexportgrant',
]);
const GIT_REF_PATTERN = /^(?!-)[a-zA-Z0-9._/-]+$/;

export const PUBLIC_INPUT_LIMITS = {
  q: 200,
  tag: 80,
  package: 201,
  version: 64,
  channel: 20,
} as const;

export type RegistrySourceValues = Record<string, unknown>;

export function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function invalidSource(message: string): never {
  throw new RegistryError('INVALID_MANIFEST', 422, message);
}

function normalizedKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function assertNoForbiddenConfigKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoForbiddenConfigKeys(item);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (CREDENTIAL_KEYS.has(normalized) || CREDENTIAL_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment))) {
      invalidSource('Source credentials belong in Git Manager or Skill Hub, not in the registry.');
    }
    if (
      SELF_GRANT_KEYS.has(normalized) ||
      (normalized.includes('export') &&
        (normalized.includes('registry') ||
          normalized.includes('grant') ||
          normalized.includes('allow') ||
          normalized.includes('enable')))
    ) {
      invalidSource('Source export grants must be configured on the provider-owned record.');
    }
    assertNoForbiddenConfigKeys(item);
  }
}

function boundedSourceString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') {
    invalidSource(`${field} must be a string.`);
  }
  const normalized = value.trim().normalize('NFC');
  if (!normalized || normalized.length > maximum || containsControlCharacters(normalized)) {
    invalidSource(`${field} must contain between 1 and ${maximum} characters.`);
  }
  return normalized;
}

function normalizeRepositoryId(value: unknown): string | number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) {
      invalidSource('providerConfig.repositoryId must be a positive integer or non-empty string.');
    }
    return value;
  }
  return boundedSourceString(value, 'providerConfig.repositoryId', 120);
}

function normalizeGitRef(value: unknown): string {
  const ref = boundedSourceString(value, 'providerConfig.ref', 255);
  const segments = ref.split('/');
  if (
    !GIT_REF_PATTERN.test(ref) ||
    ref === '@' ||
    ref.includes('..') ||
    ref.includes('@{') ||
    ref.includes('//') ||
    ref.endsWith('/') ||
    ref.endsWith('.') ||
    segments.some((segment) => segment.startsWith('.') || segment.toLowerCase().endsWith('.lock'))
  ) {
    invalidSource('providerConfig.ref must be a valid Git reference or commit SHA.');
  }
  return ref;
}

function normalizeRootPath(value: unknown): string {
  if (value === undefined || value === '') {
    return '';
  }
  if (typeof value !== 'string') {
    invalidSource('providerConfig.rootPath must be a string.');
  }
  const rootPath = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '').normalize('NFC');
  if (
    rootPath.length > 500 ||
    !rootPath ||
    rootPath.includes('\0') ||
    rootPath.startsWith('/') ||
    /^[A-Za-z]:/.test(rootPath) ||
    rootPath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    invalidSource('providerConfig.rootPath must be a safe relative path of at most 500 characters.');
  }
  return rootPath;
}

function assertOnlyFields(values: RegistrySourceValues, allowed: Set<string>, objectName: string): void {
  const unsupported = Object.keys(values).find((field) => !allowed.has(field));
  if (unsupported) {
    invalidSource(`${objectName} does not accept field ${unsupported}.`);
  }
}

function normalizeGitConfig(value: unknown): RegistrySourceValues {
  if (!isRecord(value)) {
    invalidSource('providerConfig must be an object.');
  }
  assertNoForbiddenConfigKeys(value);
  assertOnlyFields(value, GIT_CONFIG_FIELDS, 'Git Manager providerConfig');
  return {
    repositoryId: normalizeRepositoryId(value.repositoryId),
    ref: normalizeGitRef(value.ref),
    rootPath: normalizeRootPath(value.rootPath),
  };
}

function normalizeSkillDefinitionId(value: unknown): string | number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) {
      invalidSource('providerConfig.skillDefinitionIds must contain only positive integer or non-empty string ids.');
    }
    return value;
  }
  return boundedSourceString(value, 'providerConfig.skillDefinitionIds item', 120);
}

function normalizeSkillHubConfig(value: unknown): RegistrySourceValues {
  if (!isRecord(value)) {
    invalidSource('providerConfig must be an object.');
  }
  assertNoForbiddenConfigKeys(value);
  assertOnlyFields(value, SKILL_HUB_CONFIG_FIELDS, 'Skill Hub providerConfig');
  if (value.skillDefinitionIds === undefined) {
    return {};
  }
  if (!Array.isArray(value.skillDefinitionIds) || value.skillDefinitionIds.length > 500) {
    invalidSource('providerConfig.skillDefinitionIds must be an array with at most 500 ids.');
  }
  return { skillDefinitionIds: value.skillDefinitionIds.map(normalizeSkillDefinitionId) };
}

function normalizeCompleteSource(values: RegistrySourceValues): RegistrySourceValues {
  const name = boundedSourceString(values.name, 'Source name', 120);
  const providerType = values.providerType;
  if (providerType !== 'skill-hub' && providerType !== 'git-manager') {
    invalidSource('providerType must be skill-hub or git-manager.');
  }
  if (typeof values.namespace !== 'string') {
    invalidSource('Source namespace must be a string.');
  }
  const namespace = normalizeIdentity(values.namespace, 'namespace');
  const enabled = values.enabled === undefined ? true : values.enabled;
  if (typeof enabled !== 'boolean') {
    invalidSource('enabled must be a boolean.');
  }
  const syncPolicy = values.syncPolicy === undefined ? 'manual' : values.syncPolicy;
  if (syncPolicy !== 'manual' && syncPolicy !== 'interval') {
    invalidSource('syncPolicy must be manual or interval.');
  }
  let syncIntervalMinutes = values.syncIntervalMinutes ?? null;
  if (syncPolicy === 'manual') {
    syncIntervalMinutes = null;
  } else if (
    typeof syncIntervalMinutes !== 'number' ||
    !Number.isInteger(syncIntervalMinutes) ||
    syncIntervalMinutes < 1 ||
    syncIntervalMinutes > 1440
  ) {
    invalidSource('syncIntervalMinutes must be an integer from 1 to 1440 for interval sync.');
  }
  const rawProviderConfig = values.providerConfig === undefined ? {} : values.providerConfig;
  const providerConfig =
    providerType === 'git-manager' ? normalizeGitConfig(rawProviderConfig) : normalizeSkillHubConfig(rawProviderConfig);
  return {
    name,
    providerType,
    namespace,
    providerConfig,
    enabled,
    syncPolicy,
    syncIntervalMinutes,
  };
}

export function normalizeSourceCreateValues(values: RegistrySourceValues): RegistrySourceValues {
  assertOnlyFields(values, SOURCE_MUTABLE_FIELDS, 'Skill Registry source');
  return normalizeCompleteSource(values);
}

export function normalizeSourceUpdateValues(
  current: RegistrySourceValues,
  patch: RegistrySourceValues,
): RegistrySourceValues {
  assertOnlyFields(patch, SOURCE_MUTABLE_FIELDS, 'Skill Registry source');
  const normalized = normalizeCompleteSource({ ...current, ...patch });
  const result: RegistrySourceValues = {};
  for (const field of SOURCE_MUTABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      result[field] = normalized[field];
    }
  }
  if (normalized.syncPolicy === 'manual' && Object.prototype.hasOwnProperty.call(patch, 'syncPolicy')) {
    result.syncIntervalMinutes = null;
  }
  return result;
}

export function normalizeIdentity(value: string, field: 'namespace' | 'slug'): string {
  const normalized = value.trim().toLowerCase();
  const maximum = field === 'namespace' ? 80 : 120;
  if (normalized.length > maximum || !IDENTITY_PATTERN.test(normalized)) {
    throw new RegistryError(
      'INVALID_MANIFEST',
      422,
      `Invalid ${field}: use at most ${maximum} lowercase letters, digits and hyphens.`,
    );
  }
  return normalized;
}

export function isValidPublicPackageName(value: string): boolean {
  if (value.length > PUBLIC_INPUT_LIMITS.package) {
    return false;
  }
  const [namespace, slug, extra] = value.split('/');
  return (
    !extra &&
    Boolean(namespace) &&
    Boolean(slug) &&
    namespace.length <= 80 &&
    slug.length <= 120 &&
    IDENTITY_PATTERN.test(namespace) &&
    IDENTITY_PATTERN.test(slug)
  );
}

export function isValidSemver(version: string): boolean {
  return version.length <= PUBLIC_INPUT_LIMITS.version && SEMVER_PATTERN.test(version);
}

export function isValidChannel(channel: string): boolean {
  return channel.length <= PUBLIC_INPUT_LIMITS.channel && CHANNEL_PATTERN.test(channel);
}

export function assertChannel(channel: string): string {
  const normalized = channel.trim().toLowerCase();
  if (!isValidChannel(normalized)) {
    throw new RegistryError(
      'INVALID_MANIFEST',
      422,
      `Channel must use at most ${PUBLIC_INPUT_LIMITS.channel} lowercase letters, digits and hyphens.`,
    );
  }
  return normalized;
}

export function assertSemver(version: string): string {
  const normalized = version.trim();
  if (normalized.length > PUBLIC_INPUT_LIMITS.version || !SEMVER_PATTERN.test(normalized)) {
    throw new RegistryError('INVALID_SEMVER', 422, 'Version must be a valid SemVer value such as 1.2.3.');
  }
  return normalized;
}

export function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').normalize('NFC');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new RegistryError('ARTIFACT_UNSAFE_PATH', 422, `Unsafe artifact path: ${value}`);
  }
  return normalized;
}

export function parsePositiveInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), maximum);
}
