import { BlockModel } from '@nocobase/client';
import { escapeT } from '@nocobase/flow-engine';
import React from 'react';
import { EmbedSettingsBlock } from '../EmbedSettingsBlock';
import {
  decodeCollectionPath,
  EmbedSettingsCollectionSelect,
  encodeCollectionPath,
} from '../EmbedSettingsCollectionSelect';
import { EmbedSettingsPluginSelect } from '../EmbedSettingsPluginSelect';
import { EmbedSettingsTabSelect } from '../EmbedSettingsTabSelect';

export class EmbedSettingsBlockModel extends BlockModel {
  renderComponent() {
    const { pluginName, enabledTabKeys, dataSourceName, collectionName } = this.props;
    return React.createElement(EmbedSettingsBlock, { pluginName, enabledTabKeys, dataSourceName, collectionName });
  }
}

EmbedSettingsBlockModel.registerFlow({
  key: 'embedSettingsBlockSettings',
  title: escapeT('Embed settings block setting', { ns: 'plugin-block-embed-settings' }),
  steps: {
    selectPlugin: {
      title: escapeT('Select plugin', { ns: 'plugin-block-embed-settings' }),
      uiSchema(ctx) {
        const t = ctx.t;
        return {
          pluginName: {
            title: t('Select plugin'),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': EmbedSettingsPluginSelect,
            'x-component-props': {
              placeholder: t('Select plugin'),
            },
            required: true,
          },
          enabledTabKeys: {
            title: t('Enabled tabs'),
            type: 'array',
            'x-decorator': 'FormItem',
            'x-component': EmbedSettingsTabSelect,
          },
          collectionPath: {
            title: t('Collection'),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': EmbedSettingsCollectionSelect,
            default: encodeCollectionPath(ctx.model.props.dataSourceName, ctx.model.props.collectionName),
          },
        };
      },
      async handler(ctx, params) {
        const { pluginName, enabledTabKeys, collectionPath } = params;
        const { dataSourceName, collectionName } = decodeCollectionPath(collectionPath);
        ctx.model.setProps({
          pluginName,
          enabledTabKeys: Array.isArray(enabledTabKeys) ? enabledTabKeys : undefined,
          dataSourceName,
          collectionName,
        });
      },
    },
  },
});

EmbedSettingsBlockModel.define({
  label: escapeT('Plugin Settings', { ns: 'plugin-block-embed-settings' }),
});
