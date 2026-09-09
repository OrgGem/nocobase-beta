import type { Context } from '@nocobase/actions';
import { describe, expect, it, vi } from 'vitest';
import {
  deleteResponseRecord,
  getResponseRecord,
  loadConversationChain,
  cleanupExpiredResponseRecords,
  RESPONSE_RETENTION_MS,
  storeResponseRecord,
} from '../utils/response-store';
import { chatResultToResponse } from '../utils/responses-format';

function row(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] };
}

function context(findOne: ReturnType<typeof vi.fn>, create = vi.fn()) {
  return {
    db: {
      getRepository: vi.fn().mockReturnValue({ findOne, create }),
    },
  } as unknown as Context;
}

describe('Responses API response store', () => {
  it('scopes response retrieval by both response ID and user ID', async () => {
    const findOne = vi.fn().mockResolvedValue(null);
    const ctx = context(findOne);

    await getResponseRecord(ctx, 'resp_private', 42);

    expect(findOne).toHaveBeenCalledWith({ filter: { responseId: 'resp_private', userId: 42 } });
  });

  it('treats expired records as missing', async () => {
    const findOne = vi.fn().mockResolvedValue(
      row({
        id: 1,
        responseId: 'resp_expired',
        userId: 42,
        model: 'service/model',
        input: 'Hi',
        output: {},
        expiresAt: new Date(Date.now() - 1000),
      }),
    );

    await expect(getResponseRecord(context(findOne), 'resp_expired', 42)).resolves.toBeNull();
  });

  it('treats missing or malformed expiry timestamps as missing', async () => {
    for (const expiresAt of [undefined, 'not-a-date']) {
      const findOne = vi.fn().mockResolvedValue(
        row({
          id: 1,
          responseId: 'resp_invalid_expiry',
          userId: 42,
          model: 'service/model',
          input: 'Hi',
          output: {},
          expiresAt,
        }),
      );
      await expect(getResponseRecord(context(findOne), 'resp_invalid_expiry', 42)).resolves.toBeNull();
    }
  });

  it('loads a chain in chronological input/output order', async () => {
    const first = chatResultToResponse({
      id: 'resp_first',
      model: 'service/model',
      content: 'First answer',
      requestBody: { input: 'First question' },
    });
    const second = chatResultToResponse({
      id: 'resp_second',
      model: 'service/model',
      content: 'Second answer',
      requestBody: { input: 'Second question', previous_response_id: 'resp_first' },
    });
    const records: Record<string, unknown> = {
      resp_first: row({
        id: 1,
        responseId: 'resp_first',
        userId: 42,
        model: 'service/model',
        input: 'First question',
        output: first,
        expiresAt: new Date(Date.now() + 10_000),
      }),
      resp_second: row({
        id: 2,
        responseId: 'resp_second',
        userId: 42,
        model: 'service/model',
        input: 'Second question',
        output: second,
        previousResponseId: 'resp_first',
        expiresAt: new Date(Date.now() + 10_000),
      }),
    };
    const findOne = vi.fn().mockImplementation(({ filter }) => records[filter.responseId] ?? null);

    await expect(loadConversationChain(context(findOne), 'resp_second', 42)).resolves.toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: [{ type: 'text', text: 'First answer' }] },
      { role: 'user', content: 'Second question' },
      { role: 'assistant', content: [{ type: 'text', text: 'Second answer' }] },
    ]);
  });

  it('returns null for a broken or cyclic chain', async () => {
    const output = chatResultToResponse({
      id: 'resp_cycle',
      model: 'service/model',
      content: 'Loop',
      requestBody: { input: 'Loop' },
    });
    const findOne = vi.fn().mockResolvedValue(
      row({
        id: 1,
        responseId: 'resp_cycle',
        userId: 42,
        model: 'service/model',
        input: 'Loop',
        output,
        previousResponseId: 'resp_cycle',
        expiresAt: new Date(Date.now() + 10_000),
      }),
    );

    await expect(loadConversationChain(context(findOne), 'resp_cycle', 42)).resolves.toBeNull();
  });

  it('deletes by an owner-scoped primary key lookup', async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    const record = row({
      id: 9,
      responseId: 'resp_delete',
      userId: 42,
      model: 'service/model',
      input: 'Delete',
      output: {},
      expiresAt: new Date(Date.now() + 10_000),
    });
    const ctx = {
      db: { getRepository: vi.fn().mockReturnValue({ findOne: vi.fn().mockResolvedValue(record), destroy }) },
    } as unknown as Context;

    await expect(deleteResponseRecord(ctx, 'resp_delete', 42)).resolves.toBe(true);
    expect(destroy).toHaveBeenCalledWith({ filterByTk: 9 });
  });
  it('stores by default with a 30-day expiry and honors store=false', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const ctx = context(vi.fn(), create);
    const response = chatResultToResponse({
      id: 'resp_store',
      model: 'service/model',
      content: 'Stored',
      requestBody: { input: 'Store me' },
    });
    const startedAt = Date.now();

    await storeResponseRecord(ctx, response, { input: 'Store me' }, 42);
    const expiresAt = create.mock.calls[0][0].values.expiresAt as Date;

    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(startedAt + RESPONSE_RETENTION_MS);
    expect(create).toHaveBeenCalledWith({
      values: expect.objectContaining({ responseId: 'resp_store', userId: 42, input: 'Store me' }),
    });

    create.mockClear();
    await storeResponseRecord(ctx, response, { input: 'Do not store', store: false }, 42);
    expect(create).not.toHaveBeenCalled();
  });

  it('cleans expired records in bounded batches', async () => {
    const firstBatch = Array.from({ length: 1000 }, (_, id) => row({ id: id + 1 }));
    const secondBatch = [row({ id: 1001 })];
    const find = vi.fn().mockResolvedValueOnce(firstBatch).mockResolvedValueOnce(secondBatch).mockResolvedValueOnce([]);
    const destroy = vi.fn().mockImplementation(async ({ filterByTk }) => filterByTk.length);
    const ctx = {
      db: { getRepository: vi.fn().mockReturnValue({ find, destroy }) },
    } as unknown as Context;

    await expect(cleanupExpiredResponseRecords(ctx)).resolves.toBe(1001);
    expect(find).toHaveBeenCalledTimes(3);
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ fields: ['id'], limit: 1000, sort: 'id' }));
    expect(destroy).toHaveBeenNthCalledWith(1, {
      filterByTk: Array.from({ length: 1000 }, (_, index) => index + 1),
      individualHooks: false,
    });
    expect(destroy).toHaveBeenNthCalledWith(2, { filterByTk: [1001], individualHooks: false });
  });
});
