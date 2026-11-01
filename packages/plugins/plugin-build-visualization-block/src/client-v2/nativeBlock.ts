/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { DetailsItemModel, FormItemModel, TableColumnModel } from '@nocobase/client-v2';
import type PluginDataVisualizationClient from '@nocobase/plugin-data-visualization/client-v2';
import type { FlowModelContext } from '@nocobase/flow-engine';
import type { BlockSpec } from '../shared/blockSpec';
import { createNativeBlockOptions } from './modelOptions';

export function buildNativeOptions(ctx: FlowModelContext, spec: BlockSpec, includeActions = true) {
  const collection = ctx.dataSourceManager.getCollection(spec.dataSource, spec.primaryCollection);
  if (!collection) throw new Error(ctx.t('Collection is unavailable', { ns: 'plugin-build-visualization-block' }));
  const visualization = ctx.app.pm.get('data-visualization') as PluginDataVisualizationClient | undefined;
  return createNativeBlockOptions(
    spec,
    (fieldPath, mode) => {
      const field = collection.getFieldByPath(fieldPath);
      const Model = mode === 'edit' ? FormItemModel : spec.blockType === 'table' ? TableColumnModel : DetailsItemModel;
      const binding = Model.getDefaultBindingByField(ctx, field, { fallbackToTargetTitleField: mode === 'display' });
      if (!binding) throw new Error(ctx.t('No compatible field renderer', { ns: 'plugin-build-visualization-block' }));
      const props =
        typeof binding.defaultProps === 'function' ? binding.defaultProps(ctx, field) : binding.defaultProps;
      return { use: binding.modelName, props: { ...props } };
    },
    (name) => !!visualization?.charts.getChart(name),
    includeActions,
    ctx.view?.inputArgs,
  );
}
