// SPDX-License-Identifier: Apache-2.0

import { Application, Plugin } from '@nocobase/client-v2';
import type { Instruction } from '@nocobase/plugin-workflow/client-v2';
import DocumentUnderstandingInstruction from './workflow/DocumentUnderstandingInstruction';

type WorkflowClientV2Like = {
  registerInstruction?: (type: string, instruction: Instruction | { new (): Instruction }) => void;
};

export class PluginDocumentUnderstandingClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'document-understanding',
      title: this.t('Document Understanding'),
      icon: 'FileSearchOutlined',
      aclSnippet: `pm.${this.options.name || 'document-understanding'}`,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'document-understanding',
      key: 'index',
      title: this.t('Document Understanding'),
      componentLoader: () => import('./components/PluginSettings'),
      aclSnippet: `pm.${this.options.name || 'document-understanding'}`,
    });

    const workflow = (this.app.pm.get('workflow') || this.app.pm.get('@nocobase/plugin-workflow')) as
      | WorkflowClientV2Like
      | undefined;
    workflow?.registerInstruction?.('document-understanding', DocumentUnderstandingInstruction);
  }
}

export default PluginDocumentUnderstandingClient;
