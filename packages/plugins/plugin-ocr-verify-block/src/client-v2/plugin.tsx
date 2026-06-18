import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';

export class PluginOcrVerifyBlockClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'ocr-verify-block',
      title: this.t('OCR Verify Block'),
      icon: 'FileSearchOutlined',
      aclSnippet: 'pm.ocr-verify-block.settings',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ocr-verify-block',
      key: 'index',
      title: this.t('OCR Verify Block'),
      
      componentLoader: () => import('../client/components/SettingsPage').then(m => ({ default: m.SettingsPage })),
    });

  }
}

export default PluginOcrVerifyBlockClient;
