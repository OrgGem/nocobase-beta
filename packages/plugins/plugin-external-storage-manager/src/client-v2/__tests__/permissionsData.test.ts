import { readDirectoryPermissions } from '../components/permissionsData';

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
});
