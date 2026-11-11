/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/client';
import { registerInstructions, type GuideBuildWorkflowClient } from '../client-v2/instructions';

export default class PluginWorkflowBuildGuideClient extends Plugin {
  async load() {
    const workflow = this.app.pm.get<GuideBuildWorkflowClient>('workflow');
    if (workflow) registerInstructions(workflow);
  }
}
