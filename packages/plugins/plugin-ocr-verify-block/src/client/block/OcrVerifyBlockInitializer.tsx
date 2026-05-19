import { FileSearchOutlined } from '@ant-design/icons';
import { SchemaInitializerItem, useSchemaInitializer, useSchemaInitializerItem } from '@nocobase/client';
import React from 'react';

export const OcrVerifyBlockInitializer = () => {
  const { insert } = useSchemaInitializer();
  const itemConfig = useSchemaInitializerItem();
  return (
    <SchemaInitializerItem
      {...itemConfig}
      icon={<FileSearchOutlined />}
      onClick={() => {
        insert({
          type: 'void',
          'x-settings': 'blockSettings:ocrVerify',
          'x-decorator': 'BlockItem',
          'x-decorator-props': {
            name: 'ocrVerify',
          },
          'x-component': 'OcrVerifyBlock',
          'x-component-props': {
            sourceMode: 'currentRecord',
            categoryId: '',
          },
        });
      }}
    />
  );
};
