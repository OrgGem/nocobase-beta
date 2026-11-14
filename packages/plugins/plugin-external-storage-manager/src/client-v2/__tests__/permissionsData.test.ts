// SPDX-License-Identifier: Apache-2.0

import { readDirectoryPermissions, readPermissionState } from '../../shared/permissionsData';

describe('V2 external storage permissions response', () => {
  it('reads both ordinary action wrapping and the legacy empty-role envelope', () => {
    expect(
      readDirectoryPermissions({ data: { data: { view: [1], update: ['9007199254740993'], destroy: [] } } }),
    ).toEqual({ view: [1], update: ['9007199254740993'], destroy: [] });
    expect(readDirectoryPermissions({ data: { data: { data: { view: [], update: [], destroy: [] } } } })).toEqual({
      view: [],
      update: [],
      destroy: [],
    });
  });

  it('discards malformed permission lists without coercing exact identifiers', () => {
    expect(
      readDirectoryPermissions({ data: { data: { view: [null, {}, 0, '2'], update: {}, destroy: false } } }),
    ).toEqual({ view: [0, '2'], update: [], destroy: [] });
    expect(readDirectoryPermissions(null)).toEqual({ view: [], update: [], destroy: [] });
  });

  it('accepts a complete capability payload and marks only advanced actions read-only', () => {
    expect(
      readPermissionState({
        data: { data: { view: [1], update: ['9007199254740993'], destroy: [], readOnlyActions: ['update'] } },
      }),
    ).toEqual({
      permissions: { view: [1], update: ['9007199254740993'], destroy: [] },
      readOnlyActions: ['update'],
      supported: true,
    });
  });

  it.each([
    ['missing metadata', { view: [1], update: [], destroy: [] }],
    ['malformed metadata', { view: [1], update: [], destroy: [], readOnlyActions: ['manageDirectories'] }],
    ['incomplete permission arrays', { view: [1], update: [], readOnlyActions: [] }],
    ['malformed identifiers', { view: [Number.MAX_SAFE_INTEGER + 1], update: [], destroy: [], readOnlyActions: [] }],
  ])('requires the complete safe payload when %s', (_label, payload) => {
    const state = readPermissionState(payload);

    expect(state.supported).toBe(false);
    expect(state.readOnlyActions).toEqual(['view', 'update', 'destroy']);
  });
});
