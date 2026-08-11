import { describe, expect, it } from 'vitest';
import { createCursor, parseCursor } from '../utils/cursor';

const payload = {
  v: 1 as const,
  collection: 'orders',
  sort: ['-createdAt', 'id'],
  values: ['2026-08-10T00:00:00.000Z', 10],
  filterHash: 'hash',
  exp: Date.now() + 60_000,
};

describe('database plus manager cursor', () => {
  it('round trips a signed cursor', () => {
    const token = createCursor(payload, 'secret');
    expect(parseCursor(token, 'secret')).toEqual(payload);
  });

  it('rejects a cursor signed with another secret', () => {
    const token = createCursor(payload, 'secret');
    expect(() => parseCursor(token, 'other')).toThrow('Invalid cursor');
  });

  it('rejects expired cursors', () => {
    const token = createCursor({ ...payload, exp: 1 }, 'secret');
    expect(() => parseCursor(token, 'secret')).toThrow('Expired cursor');
  });
});
