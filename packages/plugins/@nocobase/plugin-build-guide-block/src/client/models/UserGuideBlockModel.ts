import { BlockModel } from '@nocobase/client';
import { escapeT } from '@nocobase/flow-engine';
import React from 'react';
import { UserGuideBlock } from '../UserGuideBlock';

export class UserGuideBlockModel extends BlockModel {
  renderComponent() {
    const { spaceId } = this.props;
    return React.createElement(UserGuideBlock, { spaceId });
  }
}

UserGuideBlockModel.registerFlow({
  key: 'userGuideBlockSettings',
  title: escapeT('User guide block setting', { ns: 'build-guide-block' }),
  steps: {
    editUserGuide: {
      title: escapeT('Edit user guide settings', { ns: 'build-guide-block' }),
      uiSchema(ctx) {
        const t = ctx.t;
        return {
          spaceId: {
            title: t('Space'),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': 'RemoteSelect',
            'x-component-props': {
              showSearch: true,
              fieldNames: { label: 'title', value: 'id' },
              service: {
                resource: 'aiBuildGuideSpaces',
                action: 'list',
                params: {
                  filter: { status: 'completed' },
                },
              },
            },
            required: true,
          },
        };
      },
      async handler(ctx, params) {
        const { spaceId } = params;
        ctx.model.setProps({
          spaceId,
        });
      },
    },
  },
});

UserGuideBlockModel.define({
  label: escapeT('User Guide'),
});
