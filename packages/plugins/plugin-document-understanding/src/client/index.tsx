// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Plugin } from '@nocobase/client';
import type WorkflowPlugin from '@nocobase/plugin-workflow/client';
import V2DocumentUnderstandingInstruction from '../client-v2/workflow/DocumentUnderstandingInstruction';

class LegacyDocumentUnderstandingInstruction extends V2DocumentUnderstandingInstruction {}

export class PluginDocumentUnderstandingClient extends Plugin {
  async load() {
    this.pluginSettingsManager.add('document-understanding', {
      title: this.t('Document Understanding'),
      icon: 'FileSearchOutlined',
      Component: React.lazy(() => import('../client-v2/components/PluginSettings')),
      aclSnippet: 'pm.document-understanding',
    });

    const workflow = (this.app.pm.get('workflow') || this.app.pm.get('@nocobase/plugin-workflow')) as
      | WorkflowPlugin
      | undefined;
    workflow?.registerInstruction?.('document-understanding', LegacyDocumentUnderstandingInstruction);
  }
}

export default PluginDocumentUnderstandingClient;
