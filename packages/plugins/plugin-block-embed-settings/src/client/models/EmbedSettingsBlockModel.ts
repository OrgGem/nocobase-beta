import { BlockModel } from '@nocobase/client';
import { escapeT } from '@nocobase/flow-engine';
import React from 'react';
import { EmbedSettingsBlock } from '../EmbedSettingsBlock';
import { EmbedSettingsPluginSelect } from '../EmbedSettingsPluginSelect';

export class EmbedSettingsBlockModel extends BlockModel {
  renderComponent() {
    const { pluginName } = this.props;
    return React.createElement(EmbedSettingsBlock, { pluginName });
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
        };
      },
      async handler(ctx, params) {
        const { pluginName } = params;
        ctx.model.setProps({ pluginName });
      },
    },
  },
});

EmbedSettingsBlockModel.define({
  label: escapeT('Plugin Settings', { ns: 'plugin-block-embed-settings' }),
});
