/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { SchemaSettings, SchemaSettingsBlockTitleItem, SchemaSettingsBlockHeightItem } from '@nocobase/client';

export const crossJoinBlockSchemaSettings = new SchemaSettings({
  name: 'blockSettings:crossJoin',
  items: [
    {
      name: 'title',
      Component: SchemaSettingsBlockTitleItem,
    },
    {
      name: 'setTheBlockHeight',
      Component: SchemaSettingsBlockHeightItem,
    },
    {
      name: 'editMapping',
      type: 'modal',
      useComponentProps() {
        return {
          title: 'Edit Mapping',
          onSubmit: async () => {
            // TODO: implement full edit flow using useDesignable + CrossJoinConfigurator
          },
        };
      },
    },
    {
      name: 'divider',
      type: 'divider',
    },
    {
      name: 'remove',
      type: 'remove',
      componentProps: {
        removeParentsIfNoChildren: true,
        breakRemoveOn: {
          'x-component': 'Grid',
        },
      },
    },
  ],
});
