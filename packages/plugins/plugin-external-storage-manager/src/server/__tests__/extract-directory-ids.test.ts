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
  it('treats unrestricted and absent scopes as unrepresentable', () => {
    expect(extractDirectoryIds(undefined)).toBeNull();
    expect(extractDirectoryIds(null)).toBeNull();
    expect(extractDirectoryIds({})).toBeNull();
  });

  it('parses a direct id value', () => {
    expect(extractDirectoryIds({ id: 5 })).toEqual([5]);
    expect(extractDirectoryIds({ id: '7' })).toEqual(['7']);
  });

  it('parses id $in lists', () => {
    expect(extractDirectoryIds({ id: { $in: [1, 2, 3] } })).toEqual([1, 2, 3]);
  });

  it('accepts the plugin-authored single-clause $and wrapper', () => {
    expect(extractDirectoryIds({ $and: [{ id: { $in: [1, 2] } }] })).toEqual([1, 2]);
  });

  it('rejects scopes with additional conditions or unsupported operators', () => {
    expect(extractDirectoryIds({ id: { $in: [1] }, enabled: true })).toBeNull();
    expect(extractDirectoryIds({ $and: [{ id: 1 }, { id: 2 }] })).toBeNull();
    expect(extractDirectoryIds({ $or: [{ id: 1 }] })).toBeNull();
    expect(extractDirectoryIds({ id: { $ne: 1 } })).toBeNull();
    expect(extractDirectoryIds({ id: { $in: [1], $ne: 2 } })).toBeNull();
  });

  it('rejects malformed, unsafe, and templated IDs', () => {
    expect(extractDirectoryIds({ id: { $in: [1, null] } })).toBeNull();
    expect(extractDirectoryIds({ id: 9_007_199_254_740_992 })).toBeNull();
    expect(extractDirectoryIds({ id: '{{ $user.id }}' })).toBeNull();
    expect(extractDirectoryIds({ id: '' })).toBeNull();
  });
});
