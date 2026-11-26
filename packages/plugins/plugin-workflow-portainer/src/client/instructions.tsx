/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { CloudUploadOutlined, ClusterOutlined } from '@ant-design/icons';
import { Instruction } from '@nocobase/plugin-workflow/client';
import type { UseVariableOptions } from '@nocobase/plugin-workflow/client-v2';
import React from 'react';
import {
  buildControlVariableOption,
  buildRedeployVariableOption,
  defaultControlConfig,
  defaultRedeployConfig,
  type WorkflowInstructionRegistryLike,
} from '../client-v2/instructions';
import { tExpr } from '../client-v2/locale';
import { INSTRUCTION_GROUP_KEY, INSTRUCTION_TYPES } from '../shared/constants';

type NodeLike = {
  key: string;
  title: string;
};

export class PortainerStackRedeployInstructionV1 extends Instruction {
  type = INSTRUCTION_TYPES.redeploy;
  title = tExpr('Run / Redeploy Stack');
  description = tExpr(
    'Pull Git changes, build compose services, or redeploy a Portainer Stack with full environment variable control.',
  );
  group = INSTRUCTION_GROUP_KEY;
  icon = (<CloudUploadOutlined />);
  testable = true;
  FieldsetLoader = () =>
    import('../client-v2/components/RedeployFieldset').then((module) => ({ default: module.RedeployFieldset }));

  createDefaultConfig() {
    return defaultRedeployConfig();
  }

  useVariables(node: NodeLike, options?: UseVariableOptions) {
    return buildRedeployVariableOption(node, options);
  }
}

export class PortainerStackControlInstructionV1 extends Instruction {
  type = INSTRUCTION_TYPES.control;
  title = tExpr('Control / Inspect Stack');
  description = tExpr('Inspect Stack container health, start, or stop a Portainer Stack in an environment.');
  group = INSTRUCTION_GROUP_KEY;
  icon = (<ClusterOutlined />);
  testable = true;
  FieldsetLoader = () =>
    import('../client-v2/components/ControlFieldset').then((module) => ({ default: module.ControlFieldset }));

  createDefaultConfig() {
    return defaultControlConfig();
  }

  useVariables(node: NodeLike, options?: UseVariableOptions) {
    return buildControlVariableOption(node, options);
  }
}

export function registerInstructionsV1(workflow: WorkflowInstructionRegistryLike<Instruction>) {
  workflow.registerInstructionGroup?.(INSTRUCTION_GROUP_KEY, {
    key: INSTRUCTION_GROUP_KEY,
    label: tExpr('Portainer'),
  });
  workflow.registerInstruction?.(INSTRUCTION_TYPES.redeploy, PortainerStackRedeployInstructionV1);
  workflow.registerInstruction?.(INSTRUCTION_TYPES.control, PortainerStackControlInstructionV1);
}
