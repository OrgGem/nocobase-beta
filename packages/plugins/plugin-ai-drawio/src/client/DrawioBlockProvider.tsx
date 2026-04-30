import React from 'react';
import { SchemaComponentOptions } from '@nocobase/client';
import { DrawioBlock } from './DrawioBlock';
import { DrawioBlockInitializer } from './DrawioBlockInitializer';
import { DiagramSelect } from './components/DiagramSelect';
import { DrawioContextProvider } from './context/DrawioContext';

export const DrawioBlockProvider = (props: any) => {
  return (
    <DrawioContextProvider>
      <SchemaComponentOptions components={{ DrawioBlock, DrawioBlockInitializer, DiagramSelect }}>
        {props.children}
      </SchemaComponentOptions>
    </DrawioContextProvider>
  );
};
