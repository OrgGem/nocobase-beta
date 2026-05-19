import React from 'react';
import { SchemaComponentOptions, RemoteSelect } from '@nocobase/client';
import { EmbedSettingsBlock } from './EmbedSettingsBlock';
import { EmbedSettingsBlockInitializer } from './EmbedSettingsBlockInitializer';
import { EmbedSettingsPluginSelect } from './EmbedSettingsPluginSelect';
import { EmbedSettingsTabSelect } from './EmbedSettingsTabSelect';

export const EmbedSettingsBlockProvider = (props: any) => {
  return (
    <SchemaComponentOptions
      components={{
        EmbedSettingsBlock,
        EmbedSettingsBlockInitializer,
        EmbedSettingsPluginSelect,
        EmbedSettingsTabSelect,
        RemoteSelect,
      }}
    >
      {props.children}
    </SchemaComponentOptions>
  );
};
