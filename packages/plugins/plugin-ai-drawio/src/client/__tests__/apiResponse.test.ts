import { describe, expect, it } from 'vitest';
import { getWrappedData, getWrappedListPayload } from '../apiResponse';

describe('api response helpers', () => {
  it('unwraps NocoBase 2.1 wrapped object payloads', () => {
    expect(
      getWrappedData<{ drawioBaseUrl: string }>({ data: { data: { drawioBaseUrl: 'https://drawio.test' } } }),
    ).toEqual({ drawioBaseUrl: 'https://drawio.test' });
  });

  it('keeps legacy object payloads compatible', () => {
    expect(getWrappedData<{ drawioBaseUrl: string }>({ data: { drawioBaseUrl: 'https://drawio.test' } })).toEqual({
      drawioBaseUrl: 'https://drawio.test',
    });
  });

  it('normalizes wrapped list rows and meta', () => {
    const payload = getWrappedListPayload<{ id: string }>({
      data: {
        data: [{ id: 'd1' }],
        meta: { count: 1, page: 1, pageSize: 20, totalPage: 1 },
      },
    });

    expect(payload.rows).toEqual([{ id: 'd1' }]);
    expect(payload.meta).toEqual({ count: 1, page: 1, pageSize: 20, totalPage: 1 });
  });
});
