/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/client-v2';
import type { Instruction } from '@nocobase/plugin-workflow/client-v2';
import { registerInstructions, type GuideBuildWorkflowClient } from './instructions';

export default class PluginWorkflowBuildGuideClientV2 extends Plugin {
  async load() {
    const workflow = this.app.pm.get<
      GuideBuildWorkflowClient & {
        getInstruction(type: string): Instruction | undefined;
      }
    >('workflow');
    if (workflow) registerInstructions(workflow);
  }
}
