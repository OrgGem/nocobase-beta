/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { extractDirectoryIds } from '../actions/ext-storage';

describe('extractDirectoryIds', () => {
  it('returns [] for empty/undefined scopes', () => {
    expect(extractDirectoryIds(undefined)).toEqual([]);
    expect(extractDirectoryIds(null)).toEqual([]);
    expect(extractDirectoryIds({})).toEqual([]);
    expect(extractDirectoryIds({ $and: [] })).toEqual([]);
  });

  it('parses a direct id value', () => {
    expect(extractDirectoryIds({ id: 5 })).toEqual([5]);
    expect(extractDirectoryIds({ id: '7' })).toEqual(['7']);
  });

  it('parses id $in lists', () => {
    expect(extractDirectoryIds({ id: { $in: [1, 2, 3] } })).toEqual([1, 2, 3]);
  });

  it('flattens and dedupes $and clauses', () => {
    expect(extractDirectoryIds({ $and: [{ id: { $in: [1, 2] } }, { id: { $in: [2, 3] } }] })).toEqual([1, 2, 3]);
  });

  it('returns null for unsupported operators', () => {
    expect(extractDirectoryIds({ $or: [{ id: 1 }] })).toBeNull();
    expect(extractDirectoryIds({ id: { $ne: 1 } })).toBeNull();
    expect(extractDirectoryIds({ $and: [{ id: 1 }, { id: { $ne: 2 } }] })).toBeNull();
  });
});
