/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { BlockModel } from '@nocobase/client-v2';
import { FlowModelRenderer, tExpr, type CreateModelOptions, type FlowModel } from '@nocobase/flow-engine';
import { Empty } from 'antd';
import React from 'react';
import { readBuild, type BuildSelection } from '../buildApi';
import { BuildForm } from '../components/BuildForm';
import { NAMESPACE } from '../locale';
import { buildNativeOptions } from '../nativeBlock';

export class BuildVisualizationBlockModel extends BlockModel<{ subModels: { content?: FlowModel } }> {
  pendingOptions?: CreateModelOptions;

  async installGenerated(selection: BuildSelection) {
    if (!this.pendingOptions) return;
    const next = await this.flowEngine.createModelAsync({
      ...this.pendingOptions,
      parentId: this.uid,
      subKey: 'content',
      subType: 'object',
    });
    const previous = this.subModels.content;
    const previousFingerprint = this.props.generationFingerprint;
    this.setSubModel('content', next);
    this.setProps('generationFingerprint', JSON.stringify(selection));
    try {
      await this.save();
    } catch (error) {
      if (previous) this.setSubModel('content', previous);
      else delete this.subModels.content;
      this.setProps('generationFingerprint', previousFingerprint);
      next.remove();
      throw error;
    }
    this.pendingOptions = undefined;
    if (previous) await previous.destroy();
  }

  renderComponent() {
    return this.subModels.content ? (
      <FlowModelRenderer model={this.subModels.content} showFlowSettings={false} />
    ) : (
      <Empty description={this.context.t('Generate a block to get started', { ns: NAMESPACE })} />
    );
  }
}

BuildVisualizationBlockModel.define({
  label: tExpr('Build Visualization Block', { ns: NAMESPACE }),
  group: tExpr('AI', { ns: NAMESPACE }),
  createModelOptions: { use: 'BuildVisualizationBlockModel' },
  hide: (ctx) => !ctx.acl.can({ dataSourceKey: 'main', resourceName: 'aiVisualizationBuilds', actionName: 'build' }),
});

BuildVisualizationBlockModel.registerFlow({
  key: 'visualizationBuildSettings',
  title: tExpr('Build Visualization Block', { ns: NAMESPACE }),
  manual: true,
  sort: -100,
  steps: {
    generate: {
      preset: true,
      title: tExpr('Build Visualization Block', { ns: NAMESPACE }),
      uiMode: { type: 'dialog', props: { width: 1000 } },
      uiSchema: (ctx) => ({
        generation: {
          type: 'object',
          required: true,
          'x-decorator': 'FormItem',
          'x-component': BuildForm,
          'x-component-props': { context: ctx },
        },
      }),
      async beforeParamsSave(ctx, params: { generation?: BuildSelection }) {
        const model = ctx.model as BuildVisualizationBlockModel;
        model.pendingOptions = undefined;
        if (!params.generation?.buildId) throw new Error(ctx.t('Generate a block to get started', { ns: NAMESPACE }));
        const result = await readBuild(ctx.api, params.generation.buildId);
        if (result.buildPhase !== 'completed' || !result.blockSpec)
          throw new Error(ctx.t('Build is not completed', { ns: NAMESPACE }));
        params.generation = { buildId: result.id, spec: result.blockSpec };
        model.setStepParams('visualizationBuildSettings', 'generate', { generation: params.generation });
        if (model.subModels.content && model.props.generationFingerprint === JSON.stringify(params.generation)) return;
        if (result.blockSpec.blockType === 'chart' && !(await ctx.engine.getModelClassAsync('ChartBlockModel'))) {
          throw new Error(ctx.t('Data visualization plugin is unavailable', { ns: NAMESPACE }));
        }
        model.pendingOptions = buildNativeOptions(ctx, result.blockSpec);
      },
      async afterParamsSave(ctx, params: { generation: BuildSelection }) {
        await (ctx.model as BuildVisualizationBlockModel).installGenerated(params.generation);
      },
    },
  },
});
