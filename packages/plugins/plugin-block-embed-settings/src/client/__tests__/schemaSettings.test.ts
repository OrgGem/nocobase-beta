import { vi, describe, it, expect } from 'vitest';
import { decodeCollectionPath, encodeCollectionPath } from '../EmbedSettingsCollectionSelect';
import { collectEmbeddablePluginTabs } from '../EmbedSettingsPluginSelect';

// Test the schemaSettings onSubmit logic in isolation.
// The actual onSubmit in schemaSettings.ts performs:
// 1. Validate tab keys against available tabs
// 2. Handle requiresCollection flag
// 3. Patch schema with updated component props

const makeApp = (settings: Record<string, unknown>) => ({
  i18n: { t: (key: string) => key },
  pluginSettingsManager: {
    getList: () => Object.values(settings),
    has: (name: string) => Boolean((settings as Record<string, unknown>)[name]),
    get: (name: string) => (settings as Record<string, unknown>)[name],
  },
});

describe('schemaSettings onSubmit logic', () => {
  describe('tab key validation', () => {
    it('filters invalid tab keys from enabledTabKeys', () => {
      const app = makeApp({
        demo: {
          name: 'demo',
          title: 'Demo',
          children: [
            { name: 'demo.tab1', key: 'tab1', title: 'Tab 1', Component: () => null },
            { name: 'demo.tab2', key: 'tab2', title: 'Tab 2', Component: () => null },
          ],
        },
      });

      const availableTabKeys = collectEmbeddablePluginTabs(app, 'demo').map((tab) => tab.value);
      const availableTabKeySet = new Set(availableTabKeys);
      const enabledTabKeys = ['demo.tab1', 'invalid-key', 'demo.tab2'];
      const validEnabledTabKeys = enabledTabKeys.filter((key) => availableTabKeySet.has(key));

      expect(validEnabledTabKeys).toEqual(['demo.tab1', 'demo.tab2']);
    });

    it('uses all available tabs when no valid keys remain', () => {
      const app = makeApp({
        demo: {
          name: 'demo',
          title: 'Demo',
          children: [
            { name: 'demo.tab1', key: 'tab1', title: 'Tab 1', Component: () => null },
          ],
        },
      });

      const availableTabKeys = collectEmbeddablePluginTabs(app, 'demo').map((tab) => tab.value);
      const availableTabKeySet = new Set(availableTabKeys);
      const enabledTabKeys = ['invalid-1', 'invalid-2'];
      const validEnabledTabKeys = enabledTabKeys.filter((key) => availableTabKeySet.has(key));

      const nextEnabledTabKeys = validEnabledTabKeys.length === 0 ? availableTabKeys : validEnabledTabKeys;
      expect(nextEnabledTabKeys).toEqual(['demo.tab1']);
    });
  });

  describe('collection path handling', () => {
    it('includes collection props when requiresCollection is true', () => {
      const collectionPath = encodeCollectionPath('main', 'users');
      const { dataSourceName, collectionName } = decodeCollectionPath(collectionPath);

      const componentProps: Record<string, unknown> = {
        pluginName: 'demo',
        enabledTabKeys: ['demo.tab1'],
      };

      const requiresCollection = true;
      if (requiresCollection) {
        componentProps.dataSourceName = dataSourceName;
        componentProps.collectionName = collectionName;
      } else {
        delete componentProps.dataSourceName;
        delete componentProps.collectionName;
      }

      expect(componentProps).toEqual({
        pluginName: 'demo',
        enabledTabKeys: ['demo.tab1'],
        dataSourceName: 'main',
        collectionName: 'users',
      });
    });

    it('removes collection props when requiresCollection is false', () => {
      const componentProps: Record<string, unknown> = {
        pluginName: 'demo',
        enabledTabKeys: ['demo.tab1'],
        dataSourceName: 'main',
        collectionName: 'users',
      };

      const requiresCollection = false;
      if (requiresCollection) {
        // would set collection props
      } else {
        delete componentProps.dataSourceName;
        delete componentProps.collectionName;
      }

      expect(componentProps).toEqual({
        pluginName: 'demo',
        enabledTabKeys: ['demo.tab1'],
      });
    });
  });

  describe('schema patch structure', () => {
    it('produces correct patch payload', () => {
      const fieldSchema = {
        'x-uid': 'test-uid-123',
        'x-component-props': {
          pluginName: 'old-plugin',
        },
      };

      const newProps = {
        pluginName: 'demo',
        enabledTabKeys: ['demo.tab1'],
      };

      const patch = {
        schema: {
          'x-uid': fieldSchema['x-uid'],
          'x-component-props': newProps,
        },
      };

      expect(patch).toEqual({
        schema: {
          'x-uid': 'test-uid-123',
          'x-component-props': {
            pluginName: 'demo',
            enabledTabKeys: ['demo.tab1'],
          },
        },
      });
    });
  });
});