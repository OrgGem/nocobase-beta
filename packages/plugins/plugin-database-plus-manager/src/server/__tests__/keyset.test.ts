import { describe, expect, it } from 'vitest';
import { buildSeekFilter } from '../utils/keyset';
import { normalizeSort } from '../utils/sort';

describe('keyset pagination primitives', () => {
  it('appends a unique id tie-breaker', () => {
    expect(normalizeSort('-createdAt')).toEqual(['-createdAt', 'id']);
    expect(normalizeSort(['-createdAt', 'id'])).toEqual(['-createdAt', 'id']);
  });

  it('builds a lexicographic seek filter', () => {
    expect(buildSeekFilter({ status: 'active' }, ['-createdAt', 'id'], ['2026-08-10', 10])).toEqual({
      $and: [
        { status: 'active' },
        {
          $or: [
            { $and: [{ createdAt: { $lt: '2026-08-10' } }] },
            { $and: [{ createdAt: { $eq: '2026-08-10' } }, { id: { $gt: 10 } }] },
          ],
        },
      ],
    });
  });

  it('does not add a seek filter for the first page', () => {
    const filter = { status: 'active' };
    expect(buildSeekFilter(filter, ['id'], [])).toBe(filter);
  });
});
