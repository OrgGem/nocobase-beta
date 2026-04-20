import React from 'react';
import { SchemaComponentOptions, RemoteSelect } from '@nocobase/client';
import { EmbedSettingsBlock } from './EmbedSettingsBlock';

export const EmbedSettingsBlockProvider = (props: any) => {
  return (
    <SchemaComponentOptions components={{ EmbedSettingsBlock, RemoteSelect }}>
      {props.children}
    </SchemaComponentOptions>
  );
};
