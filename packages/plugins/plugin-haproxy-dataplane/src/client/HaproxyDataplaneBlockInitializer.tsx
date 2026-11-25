// SPDX-License-Identifier: Apache-2.0

import { ClusterOutlined } from '@ant-design/icons';
import { SchemaInitializerItem, useSchemaInitializer, useSchemaInitializerItem } from '@nocobase/client';
import React from 'react';

export const HaproxyDataplaneBlockInitializer: React.FC = () => {
  const { insert } = useSchemaInitializer();
  const itemConfig = useSchemaInitializerItem();
  return (
    <SchemaInitializerItem
      {...itemConfig}
      icon={<ClusterOutlined aria-hidden="true" />}
      onClick={() => {
        insert({
          type: 'void',
          'x-settings': 'haproxyDataplaneBlockSettings',
          'x-decorator': 'BlockItem',
          'x-decorator-props': {
            name: 'haproxyDataplane',
          },
          'x-component': 'HaproxyDataplaneBlock',
          'x-component-props': {},
        });
      }}
    />
  );
};
