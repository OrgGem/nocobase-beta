import type { Context } from '@nocobase/actions';
import type {
  PublicRegistrySettings,
  RegistryConnection,
  RegistrySettingsInput,
  SafeRegistrySettings,
} from '../../shared/types';

const DEFAULTS: Omit<
  SafeRegistrySettings,
  'id' | 'hasPassword' | 'hasBearerToken' | 'hasClientPrivateKey' | 'hasClientPrivateKeyPassphrase'
> = {
  displayName: 'Docker Registry',
  registryUrl: '',
  publicRegistryHost: '',
  credentialMode: 'anonymous',
  username: '',
  verifyTls: true,
  allowInsecureHttp: false,
  caCertificate: '',
  clientCertificate: '',
  requestTimeoutMs: 10000,
  catalogPageSize: 100,
  maxConcurrentRequests: 5,
  autoRefreshSeconds: 0,
  deleteEnabled: false,
  rawManifestEnabled: true,
  showLegacySchema1: false,
  maxTransferSizeMb: 4096,
  uploadChunkSizeMb: 4,
  transferTimeoutMs: 600000,
};

type SettingsRow = Record<string, unknown> & { id?: number };
type Encryptor = { encrypt(value: string): Promise<string>; decrypt(value: string): Promise<string> };

export class RegistryConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryConfigurationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inputValues(ctx: Context): RegistrySettingsInput {
  const actionValues = (ctx.action.params as { values?: unknown } | undefined)?.values;
  if (isRecord(actionValues)) {
    if (isRecord(actionValues.values)) return actionValues.values as RegistrySettingsInput;
    return actionValues as RegistrySettingsInput;
  }
  if (isRecord(ctx.request.body)) {
    if (isRecord(ctx.request.body.values)) return ctx.request.body.values as RegistrySettingsInput;
    return ctx.request.body as RegistrySettingsInput;
  }
  return {};
}

function appEncryptor(ctx: Context): Encryptor {
  const candidate = (ctx.app as unknown as { aesEncryptor?: Encryptor }).aesEncryptor;
  if (!candidate) throw new Error('NocoBase AES encryptor is unavailable');
  return candidate;
}

function toRow(value: unknown): SettingsRow {
  if (isRecord(value)) return value as SettingsRow;
  return {};
}

async function getRow(ctx: Context): Promise<SettingsRow> {
  const repo = ctx.db.getRepository('dockerRegistrySettings');
  let record = await repo.findOne({ filter: {}, sort: ['id'] });
  if (!record) {
    record = await repo.create({ values: DEFAULTS });
  }
  return toRow(typeof record.toJSON === 'function' ? record.toJSON() : record);
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new RegistryConfigurationError(`Value must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function validateRegistryUrl(value: string, allowInsecureHttp: boolean): string {
  if (!value) return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RegistryConfigurationError('Registry URL must be an absolute HTTP or HTTPS URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new RegistryConfigurationError(
      'Registry URL must be an HTTP or HTTPS origin without credentials, query, or hash',
    );
  }
  if (url.protocol === 'http:' && !allowInsecureHttp) {
    throw new RegistryConfigurationError('HTTP Registry URLs require Allow insecure HTTP to be enabled');
  }
  return url.toString().replace(/\/$/, '');
}

function safeSettings(row: SettingsRow): SafeRegistrySettings {
  return {
    id: typeof row.id === 'number' ? row.id : undefined,
    displayName: stringValue(row.displayName, DEFAULTS.displayName),
    registryUrl: stringValue(row.registryUrl, DEFAULTS.registryUrl),
    publicRegistryHost: stringValue(row.publicRegistryHost, DEFAULTS.publicRegistryHost),
    credentialMode:
      row.credentialMode === 'basic' || row.credentialMode === 'bearer' ? row.credentialMode : 'anonymous',
    username: stringValue(row.username, DEFAULTS.username),
    verifyTls: booleanValue(row.verifyTls, DEFAULTS.verifyTls),
    allowInsecureHttp: booleanValue(row.allowInsecureHttp, DEFAULTS.allowInsecureHttp),
    caCertificate: stringValue(row.caCertificate, DEFAULTS.caCertificate),
    clientCertificate: stringValue(row.clientCertificate, DEFAULTS.clientCertificate),
    requestTimeoutMs: numberValue(row.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 1000, 120000),
    catalogPageSize: numberValue(row.catalogPageSize, DEFAULTS.catalogPageSize, 1, 1000),
    maxConcurrentRequests: numberValue(row.maxConcurrentRequests, DEFAULTS.maxConcurrentRequests, 1, 20),
    autoRefreshSeconds: numberValue(row.autoRefreshSeconds, DEFAULTS.autoRefreshSeconds, 0, 86400),
    deleteEnabled: booleanValue(row.deleteEnabled, DEFAULTS.deleteEnabled),
    rawManifestEnabled: booleanValue(row.rawManifestEnabled, DEFAULTS.rawManifestEnabled),
    showLegacySchema1: booleanValue(row.showLegacySchema1, DEFAULTS.showLegacySchema1),
    maxTransferSizeMb: numberValue(row.maxTransferSizeMb, DEFAULTS.maxTransferSizeMb, 1, 102400),
    uploadChunkSizeMb: numberValue(row.uploadChunkSizeMb, DEFAULTS.uploadChunkSizeMb, 1, 64),
    transferTimeoutMs: numberValue(row.transferTimeoutMs, DEFAULTS.transferTimeoutMs, 10000, 3600000),
    hasPassword: Boolean(row.passwordCiphertext),
    hasBearerToken: Boolean(row.bearerTokenCiphertext),
    hasClientPrivateKey: Boolean(row.clientPrivateKeyCiphertext),
    hasClientPrivateKeyPassphrase: Boolean(row.clientPrivateKeyPassphraseCiphertext),
  };
}

export async function getSafeSettings(ctx: Context): Promise<SafeRegistrySettings> {
  return safeSettings(await getRow(ctx));
}

export async function getPublicSettings(ctx: Context): Promise<PublicRegistrySettings> {
  const settings = await getSafeSettings(ctx);
  return {
    displayName: settings.displayName,
    publicRegistryHost: settings.publicRegistryHost,
    autoRefreshSeconds: settings.autoRefreshSeconds,
    deleteEnabled: settings.deleteEnabled,
    rawManifestEnabled: settings.rawManifestEnabled,
    maxTransferSizeMb: settings.maxTransferSizeMb,
  };
}

function mergeSettings(previous: SafeRegistrySettings, values: RegistrySettingsInput): SafeRegistrySettings {
  const nextAllowInsecureHttp = booleanValue(values.allowInsecureHttp, previous.allowInsecureHttp);
  const credentialMode = values.credentialMode ?? previous.credentialMode;
  if (!['anonymous', 'basic', 'bearer'].includes(credentialMode)) {
    throw new RegistryConfigurationError('Credential mode must be anonymous, basic, or bearer');
  }

  return {
    ...previous,
    displayName: stringValue(values.displayName, previous.displayName),
    registryUrl: validateRegistryUrl(stringValue(values.registryUrl, previous.registryUrl), nextAllowInsecureHttp),
    publicRegistryHost: stringValue(values.publicRegistryHost, previous.publicRegistryHost)
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, ''),
    credentialMode,
    username: stringValue(values.username, previous.username),
    verifyTls: booleanValue(values.verifyTls, previous.verifyTls),
    allowInsecureHttp: nextAllowInsecureHttp,
    caCertificate: stringValue(values.caCertificate, previous.caCertificate),
    clientCertificate: stringValue(values.clientCertificate, previous.clientCertificate),
    requestTimeoutMs: numberValue(values.requestTimeoutMs, previous.requestTimeoutMs, 1000, 120000),
    catalogPageSize: numberValue(values.catalogPageSize, previous.catalogPageSize, 1, 1000),
    maxConcurrentRequests: numberValue(values.maxConcurrentRequests, previous.maxConcurrentRequests, 1, 20),
    autoRefreshSeconds: numberValue(values.autoRefreshSeconds, previous.autoRefreshSeconds, 0, 86400),
    deleteEnabled: booleanValue(values.deleteEnabled, previous.deleteEnabled),
    rawManifestEnabled: booleanValue(values.rawManifestEnabled, previous.rawManifestEnabled),
    showLegacySchema1: booleanValue(values.showLegacySchema1, previous.showLegacySchema1),
    maxTransferSizeMb: numberValue(values.maxTransferSizeMb, previous.maxTransferSizeMb, 1, 102400),
    uploadChunkSizeMb: numberValue(values.uploadChunkSizeMb, previous.uploadChunkSizeMb, 1, 64),
    transferTimeoutMs: numberValue(values.transferTimeoutMs, previous.transferTimeoutMs, 10000, 3600000),
  };
}

export async function getRegistryConnection(
  ctx: Context,
  overrides?: RegistrySettingsInput,
): Promise<RegistryConnection> {
  const row = await getRow(ctx);
  const safe = overrides ? mergeSettings(safeSettings(row), overrides) : safeSettings(row);
  const encryptor = appEncryptor(ctx);
  const decrypt = async (field: string): Promise<string | undefined> => {
    const value = row[field];
    return typeof value === 'string' && value ? encryptor.decrypt(value) : undefined;
  };
  const secret = async (
    inputKey: keyof RegistrySettingsInput,
    clearKey: keyof RegistrySettingsInput,
    storageKey: string,
  ): Promise<string | undefined> => {
    const candidate = overrides?.[inputKey];
    if (typeof candidate === 'string' && candidate) return candidate;
    if (overrides?.[clearKey] === true) return undefined;
    return decrypt(storageKey);
  };
  return {
    ...safe,
    password: await secret('password', 'clearPassword', 'passwordCiphertext'),
    bearerToken: await secret('bearerToken', 'clearBearerToken', 'bearerTokenCiphertext'),
    clientPrivateKey: await secret('clientPrivateKey', 'clearClientPrivateKey', 'clientPrivateKeyCiphertext'),
    clientPrivateKeyPassphrase: await secret(
      'clientPrivateKeyPassphrase',
      'clearClientPrivateKeyPassphrase',
      'clientPrivateKeyPassphraseCiphertext',
    ),
  };
}

export async function updateRegistrySettings(ctx: Context): Promise<SafeRegistrySettings> {
  const values = inputValues(ctx);
  const current = await getRow(ctx);
  const previous = safeSettings(current);
  const next = mergeSettings(previous, values);

  const update: Record<string, unknown> = {
    displayName: next.displayName,
    registryUrl: next.registryUrl,
    publicRegistryHost: next.publicRegistryHost,
    credentialMode: next.credentialMode,
    username: next.username,
    verifyTls: next.verifyTls,
    allowInsecureHttp: next.allowInsecureHttp,
    caCertificate: next.caCertificate,
    clientCertificate: next.clientCertificate,
    requestTimeoutMs: next.requestTimeoutMs,
    catalogPageSize: next.catalogPageSize,
    maxConcurrentRequests: next.maxConcurrentRequests,
    autoRefreshSeconds: next.autoRefreshSeconds,
    deleteEnabled: next.deleteEnabled,
    rawManifestEnabled: next.rawManifestEnabled,
    showLegacySchema1: next.showLegacySchema1,
    maxTransferSizeMb: next.maxTransferSizeMb,
    uploadChunkSizeMb: next.uploadChunkSizeMb,
    transferTimeoutMs: next.transferTimeoutMs,
  };
  const encryptor = appEncryptor(ctx);
  const secretUpdates: Array<[keyof RegistrySettingsInput, string, keyof RegistrySettingsInput]> = [
    ['password', 'passwordCiphertext', 'clearPassword'],
    ['bearerToken', 'bearerTokenCiphertext', 'clearBearerToken'],
    ['clientPrivateKey', 'clientPrivateKeyCiphertext', 'clearClientPrivateKey'],
    ['clientPrivateKeyPassphrase', 'clientPrivateKeyPassphraseCiphertext', 'clearClientPrivateKeyPassphrase'],
  ];
  for (const [inputKey, storageKey, clearKey] of secretUpdates) {
    if (typeof values[inputKey] === 'string' && values[inputKey]) {
      update[storageKey] = await encryptor.encrypt(values[inputKey]);
    } else if (values[clearKey] === true) {
      update[storageKey] = null;
    }
  }

  const repo = ctx.db.getRepository('dockerRegistrySettings');
  if (typeof current.id === 'number') {
    await repo.update({ filterByTk: current.id, values: update });
  } else {
    await repo.create({ values: update });
  }
  return getSafeSettings(ctx);
}
