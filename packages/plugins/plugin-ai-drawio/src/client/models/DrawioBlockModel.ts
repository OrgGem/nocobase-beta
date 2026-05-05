import { BlockModel } from '@nocobase/client';
import { escapeT } from '@nocobase/flow-engine';
import React from 'react';
import { DrawioBlock } from '../DrawioBlock';
import { DiagramSelect } from '../components/DiagramSelect';

export class DrawioBlockModel extends BlockModel {
  renderComponent() {
    // @ts-ignore
    const { diagramId, height, ui } = this.props;
    return React.createElement(DrawioBlock, { diagramId, height, ui });
  }
}

// @ts-ignore
DrawioBlockModel.registerFlow({
  key: 'drawioBlockSettings',
  title: escapeT('Drawio block setting', { ns: 'ai-drawio' }),
  steps: {
    editDrawio: {
      title: escapeT('Edit drawio block settings', { ns: 'ai-drawio' }),
      uiSchema(ctx) {
        const t = ctx.t;
        return {
          diagramId: {
            title: t('Diagram'),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': DiagramSelect,
            required: true,
          },
          height: {
            title: 'Height (px)',
            type: 'number',
            'x-decorator': 'FormItem',
            'x-component': 'InputNumber',
            'x-component-props': { min: 320, step: 40 },
          },
          ui: {
            title: 'UI mode',
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': 'Select',
            'x-component-props': {
              options: [
                { label: 'Kennedy (default)', value: 'kennedy' },
                { label: 'Min', value: 'min' },
                { label: 'Sketch', value: 'sketch' },
                { label: 'Atlas', value: 'atlas' },
              ],
            },
          },
        };
      },
      async handler(ctx, params) {
        const { diagramId, height, ui } = params;
        ctx.model.setProps({ diagramId, height, ui });
      },
    },
  },
});

// @ts-ignore
DrawioBlockModel.define({
  label: escapeT('Drawio Diagram'),
});
