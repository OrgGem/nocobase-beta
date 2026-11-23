// SPDX-License-Identifier: Apache-2.0

import { WorkflowTypedVariableInput } from '@nocobase/plugin-workflow/client-v2';
import React from 'react';
import { RcloneTransferFieldsetBase } from './RcloneTransferFieldsetBase';

export const RcloneTransferFieldset: React.FC = () => (
  <RcloneTransferFieldsetBase
    VariableInput={WorkflowTypedVariableInput as React.ComponentType<Record<string, unknown>>}
  />
);

export default RcloneTransferFieldset;
