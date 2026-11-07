/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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
