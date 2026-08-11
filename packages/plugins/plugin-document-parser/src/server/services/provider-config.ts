type JsonRecord = Record<string, unknown>;

type NormalizedProviderConfig = {
  authConfig?: JsonRecord;
  requestConfig?: JsonRecord;
};

export function normalizeProviderConfig(authConfig: unknown, requestConfig: unknown): NormalizedProviderConfig {
  const normalizedAuthConfig = normalizeObject(authConfig, 'authConfig');
  const normalizedRequestConfig = normalizeObject(requestConfig, 'requestConfig');

  if (normalizedAuthConfig) {
    normalizedAuthConfig.customHeaders = normalizeStringMap(
      normalizedAuthConfig.customHeaders,
      'authConfig.customHeaders',
    );
  }
  if (normalizedRequestConfig) {
    normalizedRequestConfig.extraFields = normalizeStringMap(
      normalizedRequestConfig.extraFields,
      'requestConfig.extraFields',
    );
    normalizedRequestConfig.extraBody = normalizeObject(normalizedRequestConfig.extraBody, 'requestConfig.extraBody');
  }

  return { authConfig: normalizedAuthConfig, requestConfig: normalizedRequestConfig };
}

function normalizeStringMap(value: unknown, field: string): Record<string, string> | undefined {
  const object = normalizeObject(value, field);
  if (object && Object.values(object).some((entry) => typeof entry !== 'string')) {
    throw new Error(`${field} must be a JSON object with string values.`);
  }
  return object as Record<string, string> | undefined;
}

function normalizeObject(value: unknown, field: string): JsonRecord | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = typeof value === 'string' ? parseJson(value, field) : value;
  if (!isRecord(parsed)) {
    throw new Error(`${field} must be a JSON object.`);
  }
  return { ...parsed };
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${field} must be valid JSON.`);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
