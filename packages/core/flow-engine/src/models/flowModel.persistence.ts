/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { FlowModel } from './flowModel';

/**
 * Persists the model through the flow engine and returns the repository result.
 */
export function saveModel(model: FlowModel): Promise<unknown> {
  if (!model.flowEngine) {
    throw new Error('FlowEngine is not set on this model. Please set flowEngine before saving.');
  }
  return model.flowEngine.saveModel(model);
}

/**
 * Persists only the step params of the model through the flow engine.
 * Used when a settings dialog finishes configuring a single flow step.
 */
export function saveStepParams(model: FlowModel): Promise<unknown> {
  if (!model.flowEngine) {
    throw new Error('FlowEngine is not set on this model. Please set flowEngine before saving.');
  }
  return model.flowEngine.saveModel(model, { onlyStepParams: true });
}
