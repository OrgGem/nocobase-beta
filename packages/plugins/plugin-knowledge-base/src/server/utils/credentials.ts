// SPDX-License-Identifier: Apache-2.0

const MASKED_SECRET = '***';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function pickAllowedValues(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    fields.filter((field) => Object.prototype.hasOwnProperty.call(value, field)).map((field) => [field, value[field]]),
  );
}

export function credentialChangeNeedsConfirmation(previous: unknown, incoming: unknown, fields: string[]): boolean {
  const oldValues = isRecord(previous) ? previous : {};
  const newValues = isRecord(incoming) ? incoming : {};
  const hasStoredSecret = fields.some((field) => Boolean(oldValues[field]));
  const hasExplicitSecret = fields.some(
    (field) => newValues[field] !== undefined && newValues[field] !== MASKED_SECRET,
  );
  return hasStoredSecret && !hasExplicitSecret;
}

export function withoutSecrets(value: unknown, fields: string[]): Record<string, unknown> {
  const result = isRecord(value) ? { ...value } : {};
  for (const field of fields) delete result[field];
  return result;
}

export function vectorCredentialRecipientChanged(
  oldProvider: unknown,
  previous: unknown,
  nextProvider: unknown,
  incoming: unknown,
): boolean {
  if (oldProvider !== nextProvider) return true;
  const oldParams = isRecord(previous) ? previous : {};
  const newParams = isRecord(incoming) ? incoming : {};
  if (oldProvider === 'qdrant') return String(oldParams.url ?? '') !== String(newParams.url ?? '');
  return (
    ['host', 'username', 'database'].some(
      (field) => String(oldParams[field] ?? '') !== String(newParams[field] ?? ''),
    ) || String(oldParams.port || 5432) !== String(newParams.port || 5432)
  );
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const data = typeof value.toJSON === 'function' ? value.toJSON() : value;
  return isRecord(data) ? { ...data } : null;
}

export function mergeSecretValues(
  previous: unknown,
  incoming: unknown,
  secretFields: string[],
): Record<string, unknown> {
  const oldValues = isRecord(previous) ? previous : {};
  const newValues = isRecord(incoming) ? incoming : {};
  const merged = { ...oldValues, ...newValues };
  for (const field of secretFields) {
    const value = newValues[field];
    if (value === undefined || value === MASKED_SECRET) {
      if (oldValues[field] === undefined) delete merged[field];
      else merged[field] = oldValues[field];
    } else if (value === null || value === '') {
      delete merged[field];
    }
  }
  return merged;
}

export function serializeVectorDatabase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(serializeVectorDatabase);
  const data = plainRecord(value);
  if (!data) return value;
  if (isRecord(data.connectParams)) {
    const params = { ...data.connectParams };
    for (const field of ['password', 'apiKey']) {
      if (params[field]) params[field] = MASKED_SECRET;
      else delete params[field];
    }
    data.connectParams = params;
  }
  return data;
}

export function serializeVectorStore(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(serializeVectorStore);
  const data = plainRecord(value);
  if (!data) return value;
  if (data.vectorDatabase) data.vectorDatabase = serializeVectorDatabase(data.vectorDatabase);
  return data;
}

export function serializeKnowledgeBase(value: unknown): Record<string, unknown> | null {
  const data = plainRecord(value);
  if (!data) return null;
  if (isRecord(data.options)) {
    const options: Record<string, unknown> = { ...data.options, hasRagApiKey: Boolean(data.options.ragApiKey) };
    delete options.ragApiKey;
    data.options = options;
  }
  if (Array.isArray(data.documents)) {
    data.documents = data.documents.filter((document) => !isRecord(document) || document.indexDeleted !== true);
  }
  if (data.vectorStore) data.vectorStore = serializeVectorStore(data.vectorStore);
  return data;
}
