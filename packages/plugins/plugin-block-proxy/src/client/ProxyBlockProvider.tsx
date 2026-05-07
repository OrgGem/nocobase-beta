import React from 'react';
import { SchemaComponentOptions } from '@nocobase/client';
import { ProxyBlock } from './ProxyBlock';
import { ProxyBlockInitializer } from './ProxyBlockInitializer';
import { ProxyServiceSelect } from './ProxyServiceSelect';

export const ProxyBlockProvider = (props: any) => {
  return (
    <SchemaComponentOptions
      components={{
        ProxyBlock: ProxyBlock as any,
        ProxyBlockInitializer,
        ProxyServiceSelect,
      }}
    >
      {props.children}
    </SchemaComponentOptions>
  );
};
