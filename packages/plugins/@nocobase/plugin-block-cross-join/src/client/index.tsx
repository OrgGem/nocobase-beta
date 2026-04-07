/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin, SchemaComponentOptions } from '@nocobase/client';
import React from 'react';
import { CrossJoinBlockProvider } from './CrossJoinBlockProvider';
import { CrossJoinTable } from './CrossJoinTable';
import { CrossJoinBlockInitializer } from './CrossJoinBlockInitializer';
import { crossJoinBlockSchemaSettings } from './schemaSettings';

const CrossJoinComponentProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <SchemaComponentOptions
      components={{
        CrossJoinBlockProvider,
        CrossJoinTable,
        CrossJoinBlockInitializer,
      }}
    >
      {children}
    </SchemaComponentOptions>
  );
};

export class PluginBlockCrossJoinClient extends Plugin {
  async load() {
    this.app.use(CrossJoinComponentProvider);
    this.app.schemaSettingsManager.add(crossJoinBlockSchemaSettings);

    // Add to page block initializers
    this.app.schemaInitializerManager.addItem('page:addBlock', 'otherBlocks.crossJoin', {
      title: '{{t("Cross Join")}}',
      Component: 'CrossJoinBlockInitializer',
    });

    // Add to popup initializers
    this.app.schemaInitializerManager.addItem('popup:common:addBlock', 'otherBlocks.crossJoin', {
      title: '{{t("Cross Join")}}',
      Component: 'CrossJoinBlockInitializer',
    });
  }
}

export default PluginBlockCrossJoinClient;
