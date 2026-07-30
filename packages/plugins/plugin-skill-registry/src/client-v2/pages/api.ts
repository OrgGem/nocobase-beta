export type NocoBaseListBody<T> = {
  data: T[];
  meta?: { count?: number; page?: number; pageSize?: number; totalPage?: number };
};

export type NocoBaseResponse<T> = {
  data?: T;
};

export function unwrapRecords<T>(payload: NocoBaseResponse<NocoBaseListBody<T>> | undefined): T[] {
  let current: unknown = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current && typeof current === 'object' && 'data' in current) {
      const data = (current as { data?: unknown }).data;
      if (Array.isArray(data)) return data as T[];
      current = data;
      continue;
    }
    break;
  }
  return [];
}

export function unwrapListMeta(payload: unknown): NocoBaseListBody<unknown>['meta'] {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== 'object') return undefined;
    const candidate = current as { data?: unknown; meta?: NocoBaseListBody<unknown>['meta'] };
    if (Array.isArray(candidate.data)) return candidate.meta;
    current = candidate.data;
  }
  return undefined;
}
