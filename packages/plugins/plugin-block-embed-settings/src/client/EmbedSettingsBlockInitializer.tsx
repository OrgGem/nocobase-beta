import React from 'react';
import { SettingOutlined } from '@ant-design/icons';
import { SchemaInitializerItem, useSchemaInitializer, useSchemaInitializerItem } from '@nocobase/client';

export const EmbedSettingsBlockInitializer = () => {
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
          'x-component-props': {
            pluginName: '',
          },
        });
      }}
    />
  );
};
