type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return Boolean(value) && typeof value === 'object';
}

export function getResponseBody(response: unknown): unknown {
  return isRecord(response) && 'data' in response ? response.data : response;
}

export function getActionResponseBody(response: unknown): unknown {
  const body = getResponseBody(response);
  return isRecord(body) && 'data' in body ? body.data : body;
}

export function getListRows<T>(response: unknown): T[] {
  const body = getResponseBody(response);

  if (isRecord(body)) {
    if (Array.isArray(body.data)) {
      return body.data as T[];
    }

    if (isRecord(body.data) && Array.isArray(body.data.data)) {
      return body.data.data as T[];
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
