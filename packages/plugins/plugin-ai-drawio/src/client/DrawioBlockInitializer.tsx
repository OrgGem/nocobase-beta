import React from 'react';
import { SchemaInitializerItem, useSchemaInitializer, useSchemaInitializerItem } from '@nocobase/client';
import { ApartmentOutlined } from '@ant-design/icons';

export const DrawioBlockInitializer = () => {
  const { insert } = useSchemaInitializer();
  const itemConfig = useSchemaInitializerItem();
  return (
    <SchemaInitializerItem
      {...itemConfig}
      icon={<ApartmentOutlined />}
      onClick={() => {
        insert({
          type: 'void',
          'x-settings': 'drawioBlockSettings',
          'x-decorator': 'BlockItem',
          'x-decorator-props': {
            name: 'drawio',
          },
          'x-component': 'DrawioBlock',
          'x-component-props': {},
        });
      }}
    />
  );
};
