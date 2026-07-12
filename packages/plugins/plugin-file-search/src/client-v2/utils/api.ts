export type WrappedListMeta = {
  count?: number;
  page?: number;
  pageSize?: number;
  totalPage?: number;
};

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null;
}

function toMeta(value: unknown): WrappedListMeta {
  if (!isRecord(value)) return {};
  return {
    count: typeof value.count === 'number' ? value.count : undefined,
    page: typeof value.page === 'number' ? value.page : undefined,
    pageSize: typeof value.pageSize === 'number' ? value.pageSize : undefined,
    totalPage: typeof value.totalPage === 'number' ? value.totalPage : undefined,
  };
}

export function getWrappedListPayload<T>(body: unknown): { rows: T[]; meta: WrappedListMeta } {
  if (isRecord(body)) {
    if (Array.isArray(body.data)) return { rows: body.data as T[], meta: toMeta(body.meta) };
    if (isRecord(body.data) && Array.isArray(body.data.rows)) {
      return { rows: body.data.rows as T[], meta: toMeta(body.data) };
    }
    if (Array.isArray(body.rows)) return { rows: body.rows as T[], meta: toMeta(body) };
  }
  if (Array.isArray(body)) return { rows: body as T[], meta: {} };
  return { rows: [], meta: {} };
}
