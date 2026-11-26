// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Plugin } from '@nocobase/client';
import { registerInstructions, type ReviewWorkflowClient } from './instructions';
import { reviewApprovalTaskType, type V1TaskTypeOptions } from './Approvals';
import { reviewApprovalCollection, reviewRequestCollection } from '../common/review-request-collection';
import { installReviewTestFieldset } from '../client-v2/ReviewTestFieldset';

const Settings = React.lazy(() => import('../client-v2/Settings'));

type V1WorkflowClient = ReviewWorkflowClient & {
  triggers?: { get(key: string): Parameters<typeof installReviewTestFieldset>[0] };
  registerTaskType?: (key: string, option: V1TaskTypeOptions) => void;
};

export default class PluginWorkflowGitReviewClient extends Plugin {
  async load() {
    const dataSource = this.app.dataSourceManager.getDataSource('main');
    const registerCollections = () => {
      const missing = [reviewRequestCollection, reviewApprovalCollection].filter(
        (collection) => !dataSource.collectionManager.getCollection(collection.name),
      );
      if (missing.length) {
        dataSource.collectionManager.addCollections(missing);
      }
    };
    registerCollections();
    dataSource.addReloadCallback(registerCollections);

    const workflow = this.app.pm.get<V1WorkflowClient>('workflow');
    if (workflow) {
      installReviewTestFieldset(workflow.triggers?.get('collection'));
      registerInstructions(workflow);
      workflow.registerTaskType?.('git-review-approval', reviewApprovalTaskType);
    }
    this.app.pluginSettingsManager.add('workflow-git-review', {
      title: this.t('Git Review Workflows'),
      icon: 'BranchesOutlined',
      Component: Settings,
      aclSnippet: 'pm.plugin-workflow-git-review.manage',
    });
  }
}
