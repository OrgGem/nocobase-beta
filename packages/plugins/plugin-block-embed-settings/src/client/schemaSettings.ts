import { useFieldSchema } from '@formily/react';
import { SchemaSettings, useApp, useDesignable } from '@nocobase/client';
import { useT } from './locale';
import {
  decodeCollectionPath,
  EmbedSettingsCollectionSelect,
  encodeCollectionPath,
} from './EmbedSettingsCollectionSelect';
import { collectEmbeddablePluginTabs, EmbedSettingsPluginSelect } from './EmbedSettingsPluginSelect';
import { EmbedSettingsTabSelect } from './EmbedSettingsTabSelect';

const hasEmbedSettingsFlag = (setting: any, flag: string) => {
  if (setting?.embedSettings?.[flag]) {
    return true;
  }

  const tabs =
    typeof setting?.embedSettings?.tabs === 'function'
      ? setting.embedSettings.tabs(setting)
      : setting?.embedSettings?.tabs;
  return Array.isArray(tabs) && tabs.some((tab: any) => tab?.embedSettings?.[flag] || tab?.[flag]);
};

const pluginRequiresCollection = (app: any, pluginName?: string) => {
  if (!pluginName || !app.pluginSettingsManager.has(pluginName)) {
    return false;
  }
  const setting = app.pluginSettingsManager.getSetting(pluginName);
  if (hasEmbedSettingsFlag(setting, 'requiresCollection')) {
    return true;
  }
  return Object.keys(setting?.children || {}).some((key) => {
    const child = setting.children[key];
    return hasEmbedSettingsFlag(child, 'requiresCollection');
  });
};

export const embedSettingsBlockSettings = new SchemaSettings({
  name: 'blockSettings:embedSettings',
  items: [
    {
      name: 'selectPlugin',
      type: 'modal',
      useComponentProps() {
        const fieldSchema = useFieldSchema();
        const { dn } = useDesignable();
        const app = useApp();
        const t = useT();

        const currentPluginName = fieldSchema?.['x-component-props']?.pluginName || '';
        const currentEnabledTabKeys = fieldSchema?.['x-component-props']?.enabledTabKeys;
        const currentDataSourceName = fieldSchema?.['x-component-props']?.dataSourceName;
        const currentCollectionName = fieldSchema?.['x-component-props']?.collectionName;

        return {
          title: t('Select plugin'),
          schema: {
            type: 'object',
            properties: {
              pluginName: {
                title: t('Select plugin'),
                type: 'string',
                'x-decorator': 'FormItem',
                'x-component': EmbedSettingsPluginSelect,
                'x-component-props': {
                  placeholder: t('Select plugin'),
                },
                default: currentPluginName,
                required: true,
              },
              enabledTabKeys: {
                title: t('Enabled tabs'),
                type: 'array',
                'x-decorator': 'FormItem',
                'x-component': EmbedSettingsTabSelect,
                default: Array.isArray(currentEnabledTabKeys) ? currentEnabledTabKeys : undefined,
              },
              collectionPath: {
                title: t('Collection'),
                type: 'string',
                'x-decorator': 'FormItem',
                'x-component': EmbedSettingsCollectionSelect,
                default: encodeCollectionPath(currentDataSourceName, currentCollectionName),
                'x-reactions': (field) => {
                  const requiresCollection = pluginRequiresCollection(app, field.form.values?.pluginName);
                  field.hidden = !requiresCollection;
                  field.required = requiresCollection;
                  if (!requiresCollection && field.value) {
                    field.setValue(undefined);
                  }
                },
              },
            },
          },
          onSubmit({
            pluginName,
            enabledTabKeys,
            collectionPath,
          }: {
            pluginName: string;
            enabledTabKeys?: string[];
            collectionPath?: string;
          }) {
            const requiresCollection = pluginRequiresCollection(app, pluginName);
            const availableTabKeys = collectEmbeddablePluginTabs(app, pluginName).map((tab) => tab.value);
            const availableTabKeySet = new Set(availableTabKeys);
            const validEnabledTabKeys = Array.isArray(enabledTabKeys)
              ? enabledTabKeys.filter((key) => availableTabKeySet.has(key))
              : [];
            const nextEnabledTabKeys =
              !Array.isArray(enabledTabKeys) || (enabledTabKeys.length > 0 && validEnabledTabKeys.length === 0)
                ? availableTabKeys
                : validEnabledTabKeys;
            const { dataSourceName, collectionName } = requiresCollection
              ? decodeCollectionPath(collectionPath)
              : { dataSourceName: undefined, collectionName: undefined };
            const componentProps = {
              ...fieldSchema['x-component-props'],
              pluginName,
              enabledTabKeys: nextEnabledTabKeys,
            };
            if (requiresCollection) {
              componentProps.dataSourceName = dataSourceName;
              componentProps.collectionName = collectionName;
            } else {
              delete componentProps.dataSourceName;
              delete componentProps.collectionName;
            }
            fieldSchema['x-component-props'] = componentProps;
            dn.emit('patch', {
              schema: {
                'x-uid': fieldSchema['x-uid'],
                'x-component-props': componentProps,
              },
            });
            dn.refresh();
          },
        };
      },
    },
    {
      name: 'divider',
      type: 'divider',
    },
    {
      name: 'delete',
      type: 'remove',
      useComponentProps() {
        return {
          removeParentsIfNoChildren: true,
          breakRemoveOn: {
            'x-component': 'Grid',
          },
        };
      },
    },
  ],
});
