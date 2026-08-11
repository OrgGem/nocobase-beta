import { describe, expect, it, vi } from 'vitest';
import { createCursorPager, type CursorPage } from '../api/pagination';

describe('cursor pager', () => {
  it('loads pages and carries the next cursor', async () => {
    const responses: CursorPage<{ id: number }>[] = [
      { rows: [{ id: 1 }], nextCursor: 'next', hasNext: true, limit: 1, sort: ['id'], mode: 'cursor' },
      { rows: [{ id: 2 }], nextCursor: null, hasNext: false, limit: 1, sort: ['id'], mode: 'cursor' },
    ];
    const request = vi.fn(async (params: Record<string, unknown>) => {
      expect(params.paginationMode).toBe('cursor');
      return responses.shift() as CursorPage<{ id: number }>;
    });
    const pager = createCursorPager(request, { collection: 'items', limit: 1 });

    await pager.next();
    await pager.next();

    expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'next' }));
  });

  it('resets the cursor when the query signature changes', async () => {
    const request = vi.fn(async () => ({
      rows: [],
      nextCursor: 'next',
      hasNext: true,
      limit: 1,
      sort: ['id'],
      mode: 'cursor' as const,
    }));
    const base = { collection: 'items', filter: { status: 'active' } };
    const pager = createCursorPager(request, base);
    await pager.next();
    await pager.reset();
    await pager.next();

    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null }));
  });
});
