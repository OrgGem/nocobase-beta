/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import _ from 'lodash';
import type { FlowModel } from './flowModel';

/**
 * Serializes a flow model instance into a plain object, recursing into sub-models.
 *
 * - Sub-models are emitted under `subModels`; array sub-models receive a positional `sortIndex`.
 * - Instance-level flow definitions are emitted under `flowRegistry`.
 */
export function serializeModel(model: FlowModel): Record<string, any> {
  const data: Record<string, any> = {
    uid: model.uid,
    ..._.omit(model['_options'], ['flowEngine']),
    props: { ...model.props },
    stepParams: model.stepParams,
    sortIndex: model.sortIndex,
    flowRegistry: {},
  };

  const subModels = model.subModels as Record<string, FlowModel | FlowModel[]>;
  for (const subModelKey in subModels) {
    const sub = subModels[subModelKey];
    if (Array.isArray(sub)) {
      data.subModels = data.subModels || {};
      data.subModels[subModelKey] = sub.map((item: FlowModel, index: number) => ({
        ...item.serialize(),
        sortIndex: index,
      }));
    } else if (sub && typeof (sub as FlowModel).serialize === 'function') {
      data.subModels = data.subModels || {};
      data.subModels[subModelKey] = (sub as FlowModel).serialize();
    }
  }

  for (const [key, flow] of model.flowRegistry.getFlows()) {
    data.flowRegistry[key] = flow.toData();
  }

  return data;
}
