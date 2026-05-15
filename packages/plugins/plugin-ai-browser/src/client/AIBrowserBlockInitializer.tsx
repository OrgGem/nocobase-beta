import React from 'react';
import { SchemaInitializerItem, useSchemaInitializer, useSchemaInitializerItem } from '@nocobase/client';
import { GlobalOutlined } from '@ant-design/icons';

export const AIBrowserBlockInitializer = () => {
  const { insert } = useSchemaInitializer();
  const itemConfig = useSchemaInitializerItem();
  return (
    <SchemaInitializerItem
      {...itemConfig}
      icon={<GlobalOutlined />}
      onClick={() => {
        insert({
          type: 'void',
          'x-settings': 'aiBrowserBlockSettings',
          'x-decorator': 'BlockItem',
          'x-decorator-props': {
            name: 'aiBrowser',
          },
          'x-component': 'AIBrowserBlock',
          'x-component-props': {
            height: 640,
          },
        });
      }}
    />
  );
};
