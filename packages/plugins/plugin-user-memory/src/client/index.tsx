/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/client';
import MemorySettingsPage from './components/MemorySettingsPage';

const SETTINGS_KEY = 'plugin-user-memory';
const SETTINGS_ACL = 'pm.plugin-user-memory.admin';

export class PluginUserMemoryClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add(SETTINGS_KEY, {
      icon: 'BulbOutlined',
      title: this.t('User Memory'),
      Component: MemorySettingsPage,
      aclSnippet: SETTINGS_ACL,
    });
  }

  async remove() {
    this.app.pluginSettingsManager.remove(SETTINGS_KEY);
  }
}

export default PluginUserMemoryClient;
