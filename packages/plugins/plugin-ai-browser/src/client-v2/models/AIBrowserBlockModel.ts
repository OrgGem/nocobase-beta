import { BlockModel } from '@nocobase/client-v2';
import { tExpr } from '@nocobase/flow-engine';
import React from 'react';
import { AIBrowserBlock, type AIBrowserBlockProps } from '../components/AIBrowserBlock';
import { decodeSessionValue } from '../session';
import { SessionSelect } from '../components/SessionSelect';

export class AIBrowserBlockModel extends BlockModel {
  renderComponent() {
    const { liveUrl, sessionId, title, height } = this.props;
    return React.createElement(AIBrowserBlock, { liveUrl, sessionId, title, height });
  }
}

AIBrowserBlockModel.registerFlow({
  key: 'aiBrowserBlockSettings',
  title: tExpr('AI Browser block settings', { ns: 'plugin-ai-browser' }),
  steps: {
    configureBrowserBlock: {
      title: tExpr('Configure AI Browser block', { ns: 'plugin-ai-browser' }),
      uiSchema(ctx) {
        const t = (key: string) => ctx.t(key, { ns: 'plugin-ai-browser' });
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
      handler(ctx, params: AIBrowserBlockProps) {
        const { liveUrl, title, height } = params;
        ctx.model.setProps({
          ...decodeSessionValue(liveUrl),
          sessionId: decodeSessionValue(liveUrl).sessionId || params.sessionId,
          title,
          height: height || 640,
        });
      },
    },
  },
});

AIBrowserBlockModel.define({
  label: tExpr('AI Browser', { ns: 'plugin-ai-browser' }),
});
