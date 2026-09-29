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
import type { ParamObject, ReadonlyModelProps, StepParams } from '../types';

/**
 * Reads the current props of the model as a readonly view.
 */
export function getModelProps(model: FlowModel): ReadonlyModelProps {
  return model.props as ReadonlyModelProps;
}

/**
 * Writes step params onto the model.
 *
 * Three call shapes are supported:
 * - `(model, flowKey, stepKey, params)` — merge params into a single step;
 * - `(model, flowKey, stepParams)` — merge a record of steps into one flow;
 * - `(model, allParams)` — merge a full `StepParams` tree.
 *
 * A no-op merge never emits; any real change emits `onStepParamsChanged` so that
 * settings UIs and dependent flows can react.
 */
export function setModelStepParams(model: FlowModel, flowKey: string, stepKey: string, params: ParamObject): void;
export function setModelStepParams(model: FlowModel, flowKey: string, stepParams: Record<string, ParamObject>): void;
export function setModelStepParams(model: FlowModel, allParams: StepParams): void;
export function setModelStepParams(
  model: FlowModel,
  flowKeyOrAllParams: string | StepParams,
  stepKeyOrStepsParams?: string | Record<string, ParamObject>,
  params?: ParamObject,
): void {
  let hasChanged = false;

  if (typeof flowKeyOrAllParams === 'string') {
    const flowKey = flowKeyOrAllParams;
    if (typeof stepKeyOrStepsParams === 'string' && params !== undefined) {
      const currentStepParams = model.stepParams[flowKey]?.[stepKeyOrStepsParams] || {};
      const nextStepParams = { ...currentStepParams, ...params };
      if (!_.isEqual(currentStepParams, nextStepParams)) {
        if (!model.stepParams[flowKey]) {
          model.stepParams[flowKey] = {};
        }
        model.stepParams[flowKey][stepKeyOrStepsParams] = nextStepParams;
        hasChanged = true;
      }
    } else if (typeof stepKeyOrStepsParams === 'object' && stepKeyOrStepsParams !== null) {
      const currentFlowParams = model.stepParams[flowKey] || {};
      const nextFlowParams = { ...currentFlowParams, ...stepKeyOrStepsParams };
      if (!_.isEqual(currentFlowParams, nextFlowParams)) {
        model.stepParams[flowKey] = nextFlowParams;
        hasChanged = true;
      }
    }
  } else if (typeof flowKeyOrAllParams === 'object' && flowKeyOrAllParams !== null) {
    for (const fk in flowKeyOrAllParams) {
      if (Object.prototype.hasOwnProperty.call(flowKeyOrAllParams, fk)) {
        const currentFlowParams = model.stepParams[fk] || {};
        const nextFlowParams = { ...currentFlowParams, ...flowKeyOrAllParams[fk] };
        if (!_.isEqual(currentFlowParams, nextFlowParams)) {
          model.stepParams[fk] = nextFlowParams;
          hasChanged = true;
        }
      }
    }
  }

  if (!hasChanged) {
    return;
  }
  model.emitter.emit('onStepParamsChanged');
}

/**
 * Reads step params from the model.
 *
 * - `(model)` — the whole `StepParams` tree;
 * - `(model, flowKey)` — all steps of one flow;
 * - `(model, flowKey, stepKey)` — a single step's params.
 */
export function getModelStepParams(model: FlowModel, flowKey: string, stepKey: string): ParamObject | undefined;
export function getModelStepParams(model: FlowModel, flowKey: string): Record<string, ParamObject> | undefined;
export function getModelStepParams(model: FlowModel): StepParams;
export function getModelStepParams(
  model: FlowModel,
  flowKey?: string,
  stepKey?: string,
): ParamObject | Record<string, ParamObject> | StepParams | undefined {
  if (flowKey && stepKey) {
    return model.stepParams[flowKey]?.[stepKey];
  }
  if (flowKey) {
    return model.stepParams[flowKey];
  }
  return model.stepParams;
}
