// SPDX-License-Identifier: Apache-2.0

import { ExtendCollectionsProvider, Plugin } from '@nocobase/client-v2';
import type { Instruction, TaskTypeOptions } from '@nocobase/plugin-workflow/client-v2';
import { NativeManualInstruction, registerInstructions, type ReviewWorkflowClient } from './instructions';
import { reviewApprovalTaskType } from './Approvals';
import { reviewRequestCollection } from '../common/review-request-collection';
import { installReviewTestFieldset } from './ReviewTestFieldset';

export default class PluginWorkflowGitReviewClientV2 extends Plugin {
  async load() {
    this.app.addProvider(ExtendCollectionsProvider, { collections: [reviewRequestCollection] });
    const workflow = this.app.pm.get<
      ReviewWorkflowClient & {
        getTriggerOptions?(type: string): Parameters<typeof installReviewTestFieldset>[0];
        getInstruction(type: string): Instruction | undefined;
        registerTaskType(type: string, option: TaskTypeOptions): void;
      }
    >('workflow');
    if (workflow) {
      installReviewTestFieldset(workflow.getTriggerOptions?.('collection'));
      registerInstructions(workflow);
      if (!workflow.getInstruction('manual')) workflow.registerInstruction('manual', NativeManualInstruction);
      workflow.registerTaskType('git-review-approval', reviewApprovalTaskType);
    }
    this.pluginSettingsManager.addMenuItem({
      key: 'workflow-git-review',
      title: this.t('Git Review Workflows'),
      icon: 'BranchesOutlined',
    });
    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'workflow-git-review',
      key: 'setup',
      title: this.t('Setup'),
      aclSnippet: 'pm.plugin-workflow-git-review.manage',
      componentLoader: () => import('./Settings'),
    });
  }
}
