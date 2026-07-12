import { getWrappedListPayload } from '../utils/api';

describe('plugin-file-search api response normalizer', () => {
  it('reads NocoBase wrapped list payloads', () => {
    const payload = getWrappedListPayload<{ id: number }>({
      data: [{ id: 1 }],
      meta: { count: 1, page: 1, pageSize: 20, totalPage: 1 },
    });

    expect(payload.rows).toEqual([{ id: 1 }]);
    expect(payload.meta.count).toBe(1);
  });

  it('keeps compatibility with unwrapped rows payloads', () => {
    const payload = getWrappedListPayload<{ id: number }>({
      rows: [{ id: 2 }],
      count: 1,
    });

    expect(payload.rows).toEqual([{ id: 2 }]);
    expect(payload.meta.count).toBe(1);
  });
});
