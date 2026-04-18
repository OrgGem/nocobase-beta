import React from 'react';
import { SchemaComponentOptions } from '@nocobase/client';
import { EmbedSettingsBlock } from './EmbedSettingsBlock';
import { EmbedSettingsBlockInitializer } from './EmbedSettingsBlockInitializer';

export const EmbedSettingsBlockProvider = (props: any) => {
  return (
    <SchemaComponentOptions components={{ EmbedSettingsBlock, EmbedSettingsBlockInitializer }}>
      {props.children}
    </SchemaComponentOptions>
  );
};
