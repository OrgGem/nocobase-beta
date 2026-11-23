// SPDX-License-Identifier: Apache-2.0

import { CloudSyncOutlined } from '@ant-design/icons';
import { Instruction } from '@nocobase/plugin-workflow/client';
import React from 'react';
import { tExpr } from '../../client-v2/locale';
import { RCLONE_TRANSFER_INSTRUCTION_TYPE, RCLONE_WORKFLOW_GROUP } from '../../shared/constants';

export class RcloneTransferLegacyInstruction extends Instruction {
  type = RCLONE_TRANSFER_INSTRUCTION_TYPE;
  title = tExpr('Rclone Sync / Copy');
  description = tExpr('Run non-blocking Rclone sync, copy, or move jobs via rclone rcd.');
  group = RCLONE_WORKFLOW_GROUP;
  async = true;
  icon = (<CloudSyncOutlined />);
  FieldsetLoader: Instruction['FieldsetLoader'] = () => import('../../client-v2/workflow/RcloneTransferFieldsetBase');

  useVariables({ key, title }: { key: string; title: string }) {
    return {
      value: key,
      label: title,
      children: [
        { value: 'taskId', label: tExpr('Task ID') },
        { value: 'rcloneJobId', label: tExpr('Rclone Job ID') },
        { value: 'success', label: tExpr('Success') },
        { value: 'bytes', label: tExpr('Transferred Bytes') },
        { value: 'totalBytes', label: tExpr('Total Bytes') },
        { value: 'duration', label: tExpr('Duration (seconds)') },
        { value: 'error', label: tExpr('Error Message') },
      ],
    };
  }
}

export interface LegacyWorkflowRegistryLike {
  registerInstructionGroup(key: string, group: { key: string; label: string }): void;
  registerInstruction(type: string, instruction: Instruction | { new (): Instruction }): void;
}

export function registerRcloneWorkflowInstructionsLegacy(workflow: LegacyWorkflowRegistryLike): void {
  workflow.registerInstructionGroup(RCLONE_WORKFLOW_GROUP, {
    key: RCLONE_WORKFLOW_GROUP,
    label: tExpr('Rclone Storage'),
  });
  workflow.registerInstruction(RCLONE_TRANSFER_INSTRUCTION_TYPE, RcloneTransferLegacyInstruction);
}
