// SPDX-License-Identifier: Apache-2.0

import { vi, describe, it, expect } from 'vitest';
import { decodeCollectionPath, encodeCollectionPath } from '../EmbedSettingsCollectionSelect';
import { EmbedSettingsBlockModel } from '../models/EmbedSettingsBlockModel';

const getSelectPluginStep = () => {
  const modelClass = EmbedSettingsBlockModel as typeof EmbedSettingsBlockModel & {
    globalFlowRegistry: {
      getFlow: (key: string) => {
        steps: {
          selectPlugin: {
            handler: (
              ctx: { model: { setProps: (props: Record<string, unknown>) => void }; app?: unknown },
              params: Record<string, unknown>,
            ) => Promise<void>;
          };
        };
      };
    };
  };
  return modelClass.globalFlowRegistry.getFlow('embedSettingsBlockSettings').steps.selectPlugin;
};

describe('EmbedSettingsBlockModel - handler logic', () => {
  describe('setProps logic', () => {
    it('sets pluginName and enabledTabKeys without polluting dataSourceName when no collection is set', async () => {
      const setProps = vi.fn();
      await getSelectPluginStep().handler(
        { model: { setProps } },
        {
          pluginName: 'demo',
          enabledTabKeys: ['demo.tab1', 'demo.tab2'],
          collectionPath: undefined,
        },
      );

      expect(setProps).toHaveBeenCalledWith({
        pluginName: 'demo',
        enabledTabKeys: ['demo.tab1', 'demo.tab2'],
        dataSourceName: undefined,
        collectionName: undefined,
      });
    });

    it('handles collectionPath with valid data source and collection', async () => {
      const setProps = vi.fn();
      await getSelectPluginStep().handler(
        { model: { setProps } },
        {
          pluginName: 'demo',
          enabledTabKeys: undefined,
          collectionPath: 'custom-ds::orders',
        },
      );

      expect(setProps).toHaveBeenCalledWith({
        pluginName: 'demo',
        enabledTabKeys: undefined,
        dataSourceName: 'custom-ds',
        collectionName: 'orders',
      });
    });

    it('handles non-array enabledTabKeys as undefined', async () => {
      const setProps = vi.fn();
      await getSelectPluginStep().handler(
        { model: { setProps } },
        {
          pluginName: 'demo',
          enabledTabKeys: 'not-an-array',
          collectionPath: undefined,
        },
      );

      expect(setProps).toHaveBeenCalledWith(expect.objectContaining({ enabledTabKeys: undefined }));
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
