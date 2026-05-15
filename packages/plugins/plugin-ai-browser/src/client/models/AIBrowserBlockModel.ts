import { BlockModel } from '@nocobase/client';
import { escapeT } from '@nocobase/flow-engine';
import React from 'react';
import { AIBrowserBlock } from '../AIBrowserBlock';
import { SessionSelect } from '../SessionSelect';

export class AIBrowserBlockModel extends BlockModel {
  renderComponent() {
    const { liveUrl, sessionId, title, height } = (this as any).props;
    return React.createElement(AIBrowserBlock, { liveUrl, sessionId, title, height });
  }
}

(AIBrowserBlockModel as any).registerFlow({
  key: 'aiBrowserBlockSettings',
  title: escapeT('AI Browser block settings', { ns: 'ai-browser' }),
  steps: {
    configureBrowserBlock: {
      title: escapeT('Configure AI Browser block', { ns: 'ai-browser' }),
      uiSchema(ctx: any) {
        const t = ctx.t;
        return {
          liveUrl: {
            title: t('Browser Session'),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': SessionSelect,
            'x-component-props': {
              placeholder: t('Select an active browser session...'),
            },
          },
          title: {
            title: t('Title'),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': 'Input',
          },
          height: {
            title: t('Height (px)'),
            type: 'number',
            'x-decorator': 'FormItem',
            'x-component': 'InputNumber',
            'x-component-props': {
              min: 320,
              max: 5000,
              step: 40,
            },
          },
        };
      },
      async handler(ctx: any, params: any) {
        const { liveUrl, title, height } = params;
        ctx.model.setProps({
          liveUrl,
          title,
          height: height || 640,
        });
      },
    },
  },
});

(AIBrowserBlockModel as any).define({
  label: escapeT('AI Browser', { ns: 'ai-browser' }),
});
