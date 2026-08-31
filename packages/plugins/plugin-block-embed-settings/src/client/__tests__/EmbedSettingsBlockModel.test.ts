import { vi, describe, it, expect } from 'vitest';
import { decodeCollectionPath, encodeCollectionPath } from '../EmbedSettingsCollectionSelect';

// Test the model's handler logic in isolation by testing the encode/decode integration
// and the setProps behavior that the model handler performs.

describe('EmbedSettingsBlockModel - handler logic', () => {
  describe('setProps logic (mirrors handler behavior)', () => {
    it('sets pluginName and enabledTabKeys correctly', () => {
      const params = {
        pluginName: 'demo',
        enabledTabKeys: ['demo.tab1', 'demo.tab2'],
        collectionPath: undefined,
      };

      const { dataSourceName, collectionName } = decodeCollectionPath(params.collectionPath);
      const result = {
        pluginName: params.pluginName,
        enabledTabKeys: Array.isArray(params.enabledTabKeys) ? params.enabledTabKeys : undefined,
        dataSourceName,
        collectionName,
      };

      expect(result).toEqual({
        pluginName: 'demo',
        enabledTabKeys: ['demo.tab1', 'demo.tab2'],
        dataSourceName: 'main',
        collectionName: undefined,
      });
    });

    it('handles collectionPath with valid data source and collection', () => {
      const params = {
        pluginName: 'demo',
        enabledTabKeys: undefined,
        collectionPath: 'custom-ds::orders',
      };

      const { dataSourceName, collectionName } = decodeCollectionPath(params.collectionPath);
      const result = {
        pluginName: params.pluginName,
        enabledTabKeys: Array.isArray(params.enabledTabKeys) ? params.enabledTabKeys : undefined,
        dataSourceName,
        collectionName,
      };

      expect(result).toEqual({
        pluginName: 'demo',
        enabledTabKeys: undefined,
        dataSourceName: 'custom-ds',
        collectionName: 'orders',
      });
    });

    it('handles empty enabledTabKeys as undefined', () => {
      const params = {
        pluginName: 'demo',
        enabledTabKeys: 'not-an-array',
        collectionPath: undefined,
      };

      const { dataSourceName, collectionName } = decodeCollectionPath(params.collectionPath);
      const result = {
        pluginName: params.pluginName,
        enabledTabKeys: Array.isArray(params.enabledTabKeys) ? params.enabledTabKeys : undefined,
        dataSourceName,
        collectionName,
      };

      expect(result.enabledTabKeys).toBeUndefined();
    });
  });

  describe('encode/decode round-trip for model props', () => {
    it('preserves data source and collection through encode/decode', () => {
      const original = { dataSourceName: 'my-ds', collectionName: 'products' };
      const encoded = encodeCollectionPath(original.dataSourceName, original.collectionName);
      const decoded = decodeCollectionPath(encoded);
      expect(decoded).toEqual(original);
    });

    it('returns undefined encoded path when no collection is set', () => {
      const encoded = encodeCollectionPath(undefined, undefined);
      expect(encoded).toBeUndefined();
    });
  });
});