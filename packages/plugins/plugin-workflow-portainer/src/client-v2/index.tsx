/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Application, ExtendCollectionsProvider, Plugin } from '@nocobase/client-v2';
import type { Instruction } from '@nocobase/plugin-workflow/client-v2';
import { portainerInstancesCollection } from '../shared/collection';
import { PORTAINER_ACL_SNIPPET } from '../shared/constants';
import { registerInstructionsV2, type WorkflowInstructionRegistryLike } from './instructions';

const MENU_KEY = 'workflow-portainer';

export class PluginWorkflowPortainerClientV2 extends Plugin<Record<string, never>, Application> {
  async load() {
    this.app.addProvider(ExtendCollectionsProvider, {
      collections: [portainerInstancesCollection],
    });

    const workflow = (this.app.pm.get('workflow') || this.app.pm.get('@nocobase/plugin-workflow')) as
      | WorkflowInstructionRegistryLike<Instruction>
      | undefined;

    if (workflow) {
      registerInstructionsV2(workflow);
    }

    this.pluginSettingsManager.addMenuItem({
      key: MENU_KEY,
      title: this.t('Portainer Workflows'),
      icon: 'CloudServerOutlined',
      aclSnippet: PORTAINER_ACL_SNIPPET,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: MENU_KEY,
      key: 'instances',
      title: this.t('Portainer Instances'),
      aclSnippet: PORTAINER_ACL_SNIPPET,
      componentLoader: () =>
        import('./components/PortainerSettingsPage').then((m) => ({ default: m.PortainerSettingsPage })),
    });
  }
}

export default PluginWorkflowPortainerClientV2;
