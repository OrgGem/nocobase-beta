import React from 'react';
import { DisplayItemModel } from '@nocobase/flow-engine';
import { DisplayTitleFieldModel } from '@nocobase/client-v2';
import { tExpr } from '../locale';
import { JsonViewer } from './JsonBlockModel';

interface DisplayJsonPreviewFieldProps {
  defaultExpandAll?: boolean;
  showRoot?: boolean;
}

export class DisplayJsonPreviewFieldModel extends DisplayTitleFieldModel<DisplayJsonPreviewFieldProps> {
  public renderComponent(value: unknown) {
    return (
      <JsonViewer
        value={value}
        defaultExpandAll={this.props.defaultExpandAll ?? true}
        showRoot={this.props.showRoot ?? true}
      />
    );
  }
}

DisplayJsonPreviewFieldModel.define({
  label: tExpr('JSON preview'),
});

DisplayJsonPreviewFieldModel.registerFlow({
  key: 'jsonPreviewFieldSettings',
  title: tExpr('JSON preview settings'),
  sort: 200,
  steps: {
    display: {
      title: tExpr('Display'),
      uiSchema: {
        defaultExpandAll: {
          type: 'boolean',
          title: tExpr('Expand all by default'),
          'x-decorator': 'FormItem',
          'x-component': 'Switch',
        },
        showRoot: {
          type: 'boolean',
          title: tExpr('Show root node'),
          'x-decorator': 'FormItem',
          'x-component': 'Switch',
        },
      },
      defaultParams: {
        defaultExpandAll: true,
        showRoot: true,
      },
      handler(ctx, params: DisplayJsonPreviewFieldProps) {
        ctx.model.setProps({
          defaultExpandAll: params.defaultExpandAll,
          showRoot: params.showRoot,
        });
      },
    },
  },
});

DisplayItemModel.bindModelToInterface('DisplayJsonPreviewFieldModel', ['json'], { isDefault: true });
DisplayItemModel.bindModelToInterface('DisplayJsonPreviewFieldModel', ['input', 'textarea']);
