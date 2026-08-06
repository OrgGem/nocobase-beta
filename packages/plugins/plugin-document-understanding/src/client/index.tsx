import React from 'react';
import { Plugin } from '@nocobase/client';

export class PluginDocumentUnderstandingClient extends Plugin {
  async load() {
    this.pluginSettingsManager.add('document-understanding', {
      title: this.t('Document Understanding'),
      icon: 'FileSearchOutlined',
      Component: React.lazy(() => import('../client-v2/components/PluginSettings')),
      aclSnippet: 'pm.document-understanding',
    });
  }
}

export default PluginDocumentUnderstandingClient;
