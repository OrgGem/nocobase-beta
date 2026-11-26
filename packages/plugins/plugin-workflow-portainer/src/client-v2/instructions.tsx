/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { CloudUploadOutlined, ClusterOutlined } from '@ant-design/icons';
import {
  defaultFieldNames,
  Instruction,
  type UseVariableOptions,
  type VariableOption,
} from '@nocobase/plugin-workflow/client-v2';
import React from 'react';
import { DEFAULT_TIMEOUT_MS, INSTRUCTION_GROUP_KEY, INSTRUCTION_TYPES } from '../shared/constants';
import type { PortainerStackControlConfig, PortainerStackRedeployConfig } from '../shared/types';
import { tExpr } from './locale';

type NodeLike = {
  key: string;
  title: string;
};

function makeVarNode(
  fieldNames: NonNullable<UseVariableOptions['fieldNames']>,
  value: string,
  label: string,
): VariableOption {
  return {
    [fieldNames.value ?? defaultFieldNames.value]: value,
    [fieldNames.label ?? defaultFieldNames.label]: label,
  };
}

export function buildRedeployVariableOption(
  { key, title }: NodeLike,
  { fieldNames = defaultFieldNames }: UseVariableOptions = {},
): VariableOption {
  const childrenKey = fieldNames.children ?? defaultFieldNames.children;
  return {
    ...makeVarNode(fieldNames, key, title),
    [childrenKey]: [
      makeVarNode(fieldNames, 'ok', tExpr('Succeeded')),
      makeVarNode(fieldNames, 'stackId', tExpr('Stack ID')),
      makeVarNode(fieldNames, 'stackName', tExpr('Stack name')),
      makeVarNode(fieldNames, 'endpointId', tExpr('Environment (Endpoint) ID')),
      makeVarNode(fieldNames, 'stackType', tExpr('Stack type')),
      makeVarNode(fieldNames, 'stackStatus', tExpr('Stack status')),
      makeVarNode(fieldNames, 'gitReference', tExpr('Git reference')),
      makeVarNode(fieldNames, 'appliedEnv', tExpr('Applied environment (masked)')),
      makeVarNode(fieldNames, 'appliedEnvCount', tExpr('Applied variable count')),
      makeVarNode(fieldNames, 'healthy', tExpr('Containers healthy')),
      makeVarNode(fieldNames, 'runningCount', tExpr('Running containers')),
      makeVarNode(fieldNames, 'totalCount', tExpr('Total containers')),
      makeVarNode(fieldNames, 'durationMs', tExpr('Duration (ms)')),
      makeVarNode(fieldNames, 'startedAt', tExpr('Started at')),
      makeVarNode(fieldNames, 'finishedAt', tExpr('Finished at')),
      makeVarNode(fieldNames, 'errorMessage', tExpr('Error message')),
    ],
  };
}

export function buildControlVariableOption(
  { key, title }: NodeLike,
  { fieldNames = defaultFieldNames }: UseVariableOptions = {},
): VariableOption {
  const childrenKey = fieldNames.children ?? defaultFieldNames.children;
  return {
    ...makeVarNode(fieldNames, key, title),
    [childrenKey]: [
      makeVarNode(fieldNames, 'ok', tExpr('Succeeded')),
      makeVarNode(fieldNames, 'action', tExpr('Executed action')),
      makeVarNode(fieldNames, 'stackId', tExpr('Stack ID')),
      makeVarNode(fieldNames, 'stackName', tExpr('Stack name')),
      makeVarNode(fieldNames, 'endpointId', tExpr('Environment (Endpoint) ID')),
      makeVarNode(fieldNames, 'stackType', tExpr('Stack type')),
      makeVarNode(fieldNames, 'stackStatus', tExpr('Stack status')),
      makeVarNode(fieldNames, 'gitReference', tExpr('Git reference')),
      makeVarNode(fieldNames, 'healthy', tExpr('Stack healthy')),
      makeVarNode(fieldNames, 'runningCount', tExpr('Running containers')),
      makeVarNode(fieldNames, 'totalCount', tExpr('Total containers')),
      makeVarNode(fieldNames, 'currentEnv', tExpr('Current environment (masked)')),
      makeVarNode(fieldNames, 'durationMs', tExpr('Duration (ms)')),
      makeVarNode(fieldNames, 'errorMessage', tExpr('Error message')),
    ],
  };
}

export function defaultRedeployConfig(): PortainerStackRedeployConfig {
  return {
    mode: 'stack',
    envStrategy: 'merge',
    repullImage: false,
    prune: false,
    envPairs: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ignoreFail: false,
  };
}

export function defaultControlConfig(): PortainerStackControlConfig {
  return {
    action: 'inspect',
    ignoreFail: false,
  };
}

export class PortainerStackRedeployInstructionV2 extends Instruction {
  type = INSTRUCTION_TYPES.redeploy;
  title = tExpr('Run / Redeploy Stack');
  description = tExpr(
    'Pull Git changes, build compose services, or redeploy a Portainer Stack with full environment variable control.',
  );
  group = INSTRUCTION_GROUP_KEY;
  icon = (<CloudUploadOutlined />);
  testable = true;
  FieldsetLoader = () =>
    import('./components/RedeployFieldset').then((module) => ({ default: module.RedeployFieldset }));

  createDefaultConfig(): PortainerStackRedeployConfig {
    return defaultRedeployConfig();
  }

  useVariables(node: NodeLike, options?: UseVariableOptions) {
    return buildRedeployVariableOption(node, options);
  }
}

export class PortainerStackControlInstructionV2 extends Instruction {
  type = INSTRUCTION_TYPES.control;
  title = tExpr('Control / Inspect Stack');
  description = tExpr('Inspect Stack container health, start, or stop a Portainer Stack in an environment.');
  group = INSTRUCTION_GROUP_KEY;
  icon = (<ClusterOutlined />);
  testable = true;
  FieldsetLoader = () => import('./components/ControlFieldset').then((module) => ({ default: module.ControlFieldset }));

  createDefaultConfig(): PortainerStackControlConfig {
    return defaultControlConfig();
  }

  useVariables(node: NodeLike, options?: UseVariableOptions) {
    return buildControlVariableOption(node, options);
  }
}

export type WorkflowInstructionRegistryLike<TBase> = {
  registerInstructionGroup?: (key: string, group: { key: string; label: string }) => void;
  registerInstruction?: (type: string, instruction: TBase | { new (): TBase }) => void;
};

export function registerInstructionsV2(workflow: WorkflowInstructionRegistryLike<Instruction>) {
  workflow.registerInstructionGroup?.(INSTRUCTION_GROUP_KEY, {
    key: INSTRUCTION_GROUP_KEY,
    label: tExpr('Portainer'),
  });
  workflow.registerInstruction?.(INSTRUCTION_TYPES.redeploy, PortainerStackRedeployInstructionV2);
  workflow.registerInstruction?.(INSTRUCTION_TYPES.control, PortainerStackControlInstructionV2);
}
