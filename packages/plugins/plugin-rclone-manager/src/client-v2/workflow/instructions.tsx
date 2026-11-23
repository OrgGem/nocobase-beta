// SPDX-License-Identifier: Apache-2.0

import { CloudSyncOutlined } from '@ant-design/icons';
import { Instruction } from '@nocobase/plugin-workflow/client-v2';
import React from 'react';
import { RCLONE_TRANSFER_INSTRUCTION_TYPE, RCLONE_WORKFLOW_GROUP } from '../../shared/constants';
import { tExpr } from '../locale';

export class RcloneTransferClientInstruction extends Instruction {
  type = RCLONE_TRANSFER_INSTRUCTION_TYPE;
  title = tExpr('Rclone Sync / Copy');
  description = tExpr('Run non-blocking Rclone sync, copy, or move jobs via rclone rcd.');
  group = RCLONE_WORKFLOW_GROUP;
  async = true;
  icon = (<CloudSyncOutlined />);
  FieldsetLoader: Instruction['FieldsetLoader'] = () => import('./RcloneTransferFieldset');

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

export interface WorkflowInstructionRegistryLike {
  registerInstructionGroup(key: string, group: { key: string; label: string }): void;
  registerInstruction(type: string, instruction: Instruction | { new (): Instruction }): void;
}

export function registerRcloneWorkflowInstructionsV2(workflow: WorkflowInstructionRegistryLike): void {
  workflow.registerInstructionGroup(RCLONE_WORKFLOW_GROUP, {
    key: RCLONE_WORKFLOW_GROUP,
    label: tExpr('Rclone Storage'),
  });
  workflow.registerInstruction(RCLONE_TRANSFER_INSTRUCTION_TYPE, RcloneTransferClientInstruction);
}
