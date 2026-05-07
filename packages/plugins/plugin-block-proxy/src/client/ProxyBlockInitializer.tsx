import React from 'react';
import {
  SchemaInitializerItem,
  SchemaInitializerItemType,
  useSchemaInitializer,
  useSchemaInitializerItem,
} from '@nocobase/client';
import { ApiOutlined } from '@ant-design/icons';
import { useProxyServiceOptions } from './ProxyServiceSelect';

/**
 * Hook that returns dynamic sub-menu items (one per configured proxy service).
 */
export const useProxyServices = (): SchemaInitializerItemType[] => {
  const { loading, options } = useProxyServiceOptions();

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

  if (options.length === 0) {
    return [
      {
        name: 'empty',
        type: 'item',
        title: 'No proxy services configured',
        disabled: true,
      },
    ];
  }

  return options.map((svc) => ({
    name: svc.value,
    type: 'item' as const,
    icon: 'ApiOutlined',
    useComponentProps: () => {
      const { insert } = useSchemaInitializer();
      return {
        title: svc.label,
        onClick: () => {
          insert({
            type: 'void',
            'x-settings': 'blockSettings:proxy',
            'x-decorator': 'CardItem',
            'x-decorator-props': {
              name: 'proxy-block',
            },
            'x-component': 'ProxyBlock',
            'x-component-props': {
              slug: svc.value,
              height: 600,
            },
          });
        },
      };
    },
  }));
};

/**
 * Standalone initializer component (inserts an empty proxy block).
 */
export const ProxyBlockInitializer: React.FC = () => {
  const { insert } = useSchemaInitializer();
  const itemConfig = useSchemaInitializerItem();

  return (
    <SchemaInitializerItem
      {...itemConfig}
      icon={<ApiOutlined />}
      onClick={() => {
        insert({
          type: 'void',
          'x-settings': 'blockSettings:proxy',
          'x-decorator': 'CardItem',
          'x-decorator-props': {
            name: 'proxy-block',
          },
          'x-component': 'ProxyBlock',
          'x-component-props': {},
        });
      }}
    />
  );
};
