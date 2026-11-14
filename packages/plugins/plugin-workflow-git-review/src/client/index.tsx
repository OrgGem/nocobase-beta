/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { Plugin } from '@nocobase/client';
import { registerInstructions, type ReviewWorkflowClient } from './instructions';
import { reviewRequestCollection } from '../common/review-request-collection';

const Settings = React.lazy(() => import('../client-v2/Settings'));

export default class PluginWorkflowGitReviewClient extends Plugin {
  async load() {
    const dataSource = this.app.dataSourceManager.getDataSource('main');
    const registerReviewRequest = () => {
      if (!dataSource.collectionManager.getCollection(reviewRequestCollection.name)) {
        dataSource.collectionManager.addCollections([reviewRequestCollection]);
      }
    };
    registerReviewRequest();
    dataSource.addReloadCallback(registerReviewRequest);

    const workflow = this.app.pm.get<ReviewWorkflowClient>('workflow');
    if (workflow) registerInstructions(workflow);
    this.app.pluginSettingsManager.add('workflow-git-review', {
      title: this.t('Git Review Workflows'),
      icon: 'BranchesOutlined',
      Component: Settings,
      aclSnippet: 'pm.plugin-workflow-git-review.manage',
    });
  }
}
