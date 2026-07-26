import React from 'react';
import { BlockModel } from '@nocobase/client-v2';
import { DrawioBlock } from '../../client/DrawioBlock';
import { DiagramSelect } from '../../client/components/DiagramSelect';
import { tExpr } from '../locale';

type DrawioBlockProps = {
  diagramId?: string;
  height?: number | string;
  ui?: 'min' | 'kennedy' | 'sketch' | 'atlas';
};

export class DrawioBlockModel extends BlockModel {
  renderComponent() {
    const { diagramId, height, ui } = this.props as DrawioBlockProps;
    return <DrawioBlock diagramId={diagramId} height={height} ui={ui} />;
  }
}

DrawioBlockModel.define({
  label: tExpr('Drawio Diagram'),
});

DrawioBlockModel.registerFlow({
  key: 'drawioBlockSettings',
  title: tExpr('Drawio block setting'),
  on: 'beforeRender',
  steps: {
    editDrawio: {
      title: tExpr('Edit drawio block settings'),
      uiSchema: {
        diagramId: {
          type: 'string',
          title: tExpr('Diagram'),
          'x-decorator': 'FormItem',
          'x-component': DiagramSelect,
          required: true,
        },
        height: {
          type: 'number',
          title: tExpr('Height (px)'),
          'x-decorator': 'FormItem',
          'x-component': 'InputNumber',
          'x-component-props': { min: 320, step: 40 },
        },
        ui: {
          type: 'string',
          title: tExpr('UI mode'),
          'x-decorator': 'FormItem',
          'x-component': 'Select',
          'x-component-props': {
            options: [
              { label: tExpr('Kennedy (default)'), value: 'kennedy' },
              { label: tExpr('Min'), value: 'min' },
              { label: tExpr('Sketch'), value: 'sketch' },
              { label: tExpr('Atlas'), value: 'atlas' },
            ],
          },
        },
      },
      handler(ctx, params) {
        ctx.model.setProps(params);
      },
    },
  },
});
