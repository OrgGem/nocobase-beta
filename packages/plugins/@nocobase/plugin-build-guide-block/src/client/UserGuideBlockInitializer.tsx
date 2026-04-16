import React from 'react';
import { SchemaInitializerItem, useSchemaInitializer, useSchemaInitializerItem } from '@nocobase/client';
import { ReadOutlined } from '@ant-design/icons';

export const UserGuideBlockInitializer = () => {
  const { insert } = useSchemaInitializer();
  const itemConfig = useSchemaInitializerItem();
  return (
    <SchemaInitializerItem
      {...itemConfig}
      icon={<ReadOutlined />}
      onClick={() => {
        insert({
          type: 'void',
          'x-settings': 'userGuideBlockSettings',
          'x-decorator': 'BlockItem',
          'x-decorator-props': {
            name: 'userGuide',
          },
          'x-component': 'UserGuideBlock',
          'x-component-props': {},
        });
      }}
    />
  );
};
