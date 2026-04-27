import React from 'react';
import { SettingOutlined } from '@ant-design/icons';
import {
  SchemaInitializerItem,
  useSchemaInitializer,
  useSchemaInitializerItem,
  SchemaInitializerItemType,
} from '@nocobase/client';
import { useEnabledEmbedSettingsPluginOptions } from './EmbedSettingsPluginSelect';

/**
 * Hook for useChildren in subMenu.
 * Returns SchemaInitializerItemType[] - each item uses `useComponentProps`
 * (the proven NocoBase pattern from plugin-block-workbench).
 */
export const useEmbedSettingsPlugins = (): SchemaInitializerItemType[] => {
  const { loading, options: pluginOptions } = useEnabledEmbedSettingsPluginOptions();

  if (loading) {
    return [
      {
        name: 'loading',
        type: 'item',
        title: 'Loading...',
        disabled: true,
      },
    ];
  }

  if (pluginOptions.length === 0) {
    return [
      {
        name: 'empty',
        type: 'item',
        title: 'No allowed plugins enabled',
        disabled: true,
      },
    ];
  }

  // Use the `useComponentProps` pattern (same as workbench plugin)
  // Each item is a standard `type: 'item'` - NocoBase renders SchemaInitializerItem by default
  return pluginOptions.map((p) => ({
    name: p.value,
    type: 'item' as const,
    icon: 'SettingOutlined',
    useComponentProps: () => {
      const { insert } = useSchemaInitializer();
      return {
        title: p.label,
        onClick: () => {
          insert({
            type: 'void',
            'x-settings': 'blockSettings:embedSettings',
            'x-decorator': 'CardItem',
            'x-decorator-props': {
              name: 'embed-settings',
            },
            'x-component': 'EmbedSettingsBlock',
            'x-component-props': {
              pluginName: p.value,
            },
          });
        },
      };
    },
  }));
};

/**
 * Standalone initializer component - inserts a blank EmbedSettingsBlock.
 * User selects plugin via gear icon (schemaSettings modal).
 */
export const EmbedSettingsBlockInitializer: React.FC = () => {
  const { insert } = useSchemaInitializer();
  const itemConfig = useSchemaInitializerItem();

  return (
    <SchemaInitializerItem
      {...itemConfig}
      icon={<SettingOutlined />}
      onClick={() => {
        insert({
          type: 'void',
          'x-settings': 'blockSettings:embedSettings',
          'x-decorator': 'CardItem',
          'x-decorator-props': {
            name: 'embed-settings',
          },
          'x-component': 'EmbedSettingsBlock',
          'x-component-props': {},
        });
      }}
    />
  );
};
