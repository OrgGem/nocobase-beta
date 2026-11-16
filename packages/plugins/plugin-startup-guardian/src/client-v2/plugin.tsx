// SPDX-License-Identifier: Apache-2.0

import { Application, Plugin } from '@nocobase/client-v2';

const SETTINGS_KEY = 'plugin-startup-guardian';
const READ_PERMISSION = 'pm.plugin-startup-guardian.read';

export class PluginStartupGuardianClientV2 extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: SETTINGS_KEY,
      title: this.t('Startup Guardian'),
      icon: 'SafetyCertificateOutlined',
      aclSnippet: READ_PERMISSION,
    });
    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'index',
      title: this.t('Startup Guardian'),
      aclSnippet: READ_PERMISSION,
      componentLoader: () => import('./StartupGuardianClientPage'),
    });
  }
}

export default PluginStartupGuardianClientV2;
