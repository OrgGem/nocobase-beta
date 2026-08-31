import { encodeCollectionPath, decodeCollectionPath } from '../EmbedSettingsCollectionSelect';

describe('encodeCollectionPath', () => {
  it('returns undefined when collectionName is undefined', () => {
    expect(encodeCollectionPath('main', undefined)).toBeUndefined();
  });

  it('returns undefined when collectionName is empty string', () => {
    expect(encodeCollectionPath('main', '')).toBeUndefined();
  });

  it('encodes dataSource and collection with separator', () => {
    expect(encodeCollectionPath('main', 'users')).toBe('main::users');
  });

  it('uses default data source key when dataSourceName is empty', () => {
    const result = encodeCollectionPath('', 'users');
    expect(result).toBe('main::users');
  });

  it('handles collection names with special characters', () => {
    expect(encodeCollectionPath('main', 'my-collection_v2')).toBe('main::my-collection_v2');
  });
});

describe('decodeCollectionPath', () => {
  it('returns defaults for undefined value', () => {
    const result = decodeCollectionPath(undefined);
    expect(result).toEqual({ dataSourceName: 'main', collectionName: undefined });
  });

  it('returns defaults for empty string value', () => {
    const result = decodeCollectionPath('');
    expect(result).toEqual({ dataSourceName: 'main', collectionName: undefined });
  });

  it('decodes simple path', () => {
    const result = decodeCollectionPath('main::users');
    expect(result).toEqual({ dataSourceName: 'main', collectionName: 'users' });
  });

  it('handles collection names containing the separator', () => {
    const result = decodeCollectionPath('main::my::collection');
    expect(result).toEqual({ dataSourceName: 'main', collectionName: 'my::collection' });
  });

  it('handles data source name only (no separator)', () => {
    const result = decodeCollectionPath('main');
    expect(result).toEqual({ dataSourceName: 'main', collectionName: undefined });
  });

  it('round-trips encode/decode correctly', () => {
    const encoded = encodeCollectionPath('custom-ds', 'orders');
    const decoded = decodeCollectionPath(encoded);
    expect(decoded).toEqual({ dataSourceName: 'custom-ds', collectionName: 'orders' });
  });
});
