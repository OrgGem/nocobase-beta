import { BlockModel } from '@nocobase/client-v2';
import { tExpr } from '@nocobase/flow-engine';
import React from 'react';
import { UserGuideBlock } from '../components/UserGuideBlock';
import { SpaceSelect } from '../components/SpaceSelect';

export class UserGuideBlockModel extends BlockModel {
  renderComponent() {
    return <UserGuideBlock spaceId={this.props.spaceId} />;
  }
}

UserGuideBlockModel.define({
  label: tExpr('User Guide', { ns: 'plugin-build-guide-block' }),
  createModelOptions: { use: 'UserGuideBlockModel' },
});

UserGuideBlockModel.registerFlow({
  key: 'userGuideBlockSettings',
  title: tExpr('User guide block setting', { ns: 'plugin-build-guide-block' }),
  steps: {
    editUserGuide: {
      title: tExpr('Edit user guide settings', { ns: 'plugin-build-guide-block' }),
      uiSchema: {
        spaceId: {
          title: tExpr('Space', { ns: 'plugin-build-guide-block' }),
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': SpaceSelect,
          required: true,
        },
      },
      handler(ctx, params) {
        ctx.model.setProps({ spaceId: params.spaceId });
      },
    },
  },
});
