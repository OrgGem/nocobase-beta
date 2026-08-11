export interface CursorPage<T> {
  rows: T[];
  nextCursor: string | null;
  hasNext: boolean;
  limit: number;
  sort: string[];
  mode: 'keyset' | 'cursor';
}

export interface CursorPageRequest {
  collection: string;
  filter?: Record<string, unknown>;
  fields?: string[];
  appends?: string[];
  except?: string[];
  sort?: string[];
  limit?: number;
  mode?: 'keyset' | 'cursor';
}

export function createCursorPager<T>(
  request: (params: Record<string, unknown>) => Promise<CursorPage<T>>,
  base: CursorPageRequest,
) {
  let cursor: string | null = null;
  let signature = JSON.stringify(base);

  return {
    async reset() {
      cursor = null;
      signature = JSON.stringify(base);
    },
    async next(): Promise<CursorPage<T>> {
      const nextSignature = JSON.stringify(base);
      if (nextSignature !== signature) {
        cursor = null;
        signature = nextSignature;
      }
      const page = await request({
        ...base,
        paginationMode: base.mode ?? 'cursor',
        cursor,
      });
      cursor = page.nextCursor;
      return page;
    },
  };
}
