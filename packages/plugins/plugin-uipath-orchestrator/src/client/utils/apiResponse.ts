type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return Boolean(value) && typeof value === 'object';
}

export function getListRows<T>(response: unknown): T[] {
  const body = isRecord(response) ? response.data : response;

  if (isRecord(body)) {
    if (Array.isArray(body.data)) {
      return body.data as T[];
    }

    if (isRecord(body.data) && Array.isArray(body.data.rows)) {
      return body.data.rows as T[];
    }

    if (Array.isArray(body.rows)) {
      return body.rows as T[];
    }
  }

  return Array.isArray(body) ? (body as T[]) : [];
}
