/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/client';
import type { Instruction } from '@nocobase/plugin-workflow/client';
import React from 'react';
import type { WorkflowInstructionRegistryLike } from '../client-v2/instructions';
import { portainerInstancesCollection } from '../shared/collection';
import { PORTAINER_ACL_SNIPPET } from '../shared/constants';
import { registerInstructionsV1 } from './instructions';

const PortainerSettingsPage = React.lazy(() => import('../client-v2/components/PortainerSettingsPage'));

export class PluginWorkflowPortainerClient extends Plugin {
  async load() {
    const dataSource = this.app.dataSourceManager.getDataSource('main');
    if (dataSource) {
      const registerCollection = () => {
        if (!dataSource.collectionManager.getCollection(portainerInstancesCollection.name)) {
          dataSource.collectionManager.addCollections([portainerInstancesCollection]);
        }
      };
      registerCollection();
      dataSource.addReloadCallback(registerCollection);
    }

    const workflow = (this.app.pm.get('workflow') || this.app.pm.get('@nocobase/plugin-workflow')) as
      | WorkflowInstructionRegistryLike<Instruction>
      | undefined;

    if (workflow) {
      registerInstructionsV1(workflow);
    }

    this.app.pluginSettingsManager.add('workflow-portainer', {
      title: this.t('Portainer Workflows'),
      icon: 'CloudServerOutlined',
      Component: PortainerSettingsPage,
      aclSnippet: PORTAINER_ACL_SNIPPET,
    });
  }
}

export default PluginWorkflowPortainerClient;
