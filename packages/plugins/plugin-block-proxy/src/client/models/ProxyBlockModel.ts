import { BlockModel } from '@nocobase/client';
import { escapeT } from '@nocobase/flow-engine';
import React from 'react';
import { ProxyBlock } from '../ProxyBlock';
import { ProxyServiceSelect } from '../ProxyServiceSelect';

export class ProxyBlockModel extends BlockModel {
  renderComponent() {
    const slug = (this as any).props?.slug;
    const height = (this as any).props?.height;
    const renderMode = (this as any).props?.renderMode;
    return React.createElement(ProxyBlock, { slug, height, renderMode });
  }
}

(ProxyBlockModel as any).registerFlow({
  key: 'proxyBlockSettings',
  title: escapeT('Proxy block settings', { ns: 'plugin-block-proxy' }),
  steps: {
    selectService: {
      title: escapeT('Configure Proxy', { ns: 'plugin-block-proxy' }),
      uiSchema(ctx: any) {
        const t = ctx.t;
        return {
          slug: {
            title: t('Proxy Service'),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': ProxyServiceSelect,
            'x-component-props': {
              placeholder: t('Select a proxy service'),
            },
            required: true,
          },
          renderMode: {
            title: t('Render Mode'),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': 'Select',
            'x-component-props': {
              options: [
                { label: 'iframe — Full SPA', value: 'iframe' },
                { label: 'Embed — Shadow DOM', value: 'embed' },
              ],
            },
          },
          height: {
            title: t('Height (px)'),
            type: 'number',
            'x-decorator': 'FormItem',
            'x-component': 'InputNumber',
            'x-component-props': {
              min: 200,
              max: 5000,
              step: 50,
            },
          },
        };
      },
      async handler(ctx: any, params: any) {
        const { slug, height, renderMode } = params;
        ctx.model.setProps({
          slug,
          height: height || 600,
          renderMode: renderMode || 'iframe',
        });
      },
    },
  },
});

(ProxyBlockModel as any).define({
  label: escapeT('Proxy Service', { ns: 'plugin-block-proxy' }),
});
