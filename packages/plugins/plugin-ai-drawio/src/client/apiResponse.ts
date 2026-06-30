type RecordLike = Record<string, unknown>;

export type WrappedListMeta = {
  count?: number;
  page?: number;
  pageSize?: number;
  totalPage?: number;
  hasNext?: boolean;
};

export type WrappedListPayload<T> = {
  rows: T[];
  meta: WrappedListMeta;
};

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function toWrappedListMeta(value: unknown): WrappedListMeta {
  if (!isRecord(value)) {
    return {};
  }

  const meta: WrappedListMeta = {};
  const count = optionalNumber(value.count);
  const page = optionalNumber(value.page);
  const pageSize = optionalNumber(value.pageSize);
  const totalPage = optionalNumber(value.totalPage);

  if (count !== undefined) meta.count = count;
  if (page !== undefined) meta.page = page;
  if (pageSize !== undefined) meta.pageSize = pageSize;
  if (totalPage !== undefined) meta.totalPage = totalPage;
  if (typeof value.hasNext === 'boolean') meta.hasNext = value.hasNext;

  return meta;
}

function getHttpBody(response: unknown): unknown {
  return isRecord(response) && 'data' in response ? response.data : response;
}

export function getWrappedData<T>(response: unknown): T | undefined {
  const body = getHttpBody(response);

  if (isRecord(body) && 'data' in body) {
    return body.data as T;
  }

  return body as T | undefined;
}

export function getWrappedListPayload<T>(response: unknown): WrappedListPayload<T> {
  const body = getHttpBody(response);

  if (isRecord(body)) {
    const wrappedRows = body.data;

    if (Array.isArray(wrappedRows)) {
      return { rows: wrappedRows as T[], meta: toWrappedListMeta(body.meta) };
    }

    if (isRecord(wrappedRows) && Array.isArray(wrappedRows.rows)) {
      return { rows: wrappedRows.rows as T[], meta: toWrappedListMeta(wrappedRows) };
    }

    if (Array.isArray(body.rows)) {
      return { rows: body.rows as T[], meta: toWrappedListMeta(body) };
    }
  }

  if (Array.isArray(body)) {
    return { rows: body as T[], meta: {} };
  }

  return { rows: [], meta: {} };
}
