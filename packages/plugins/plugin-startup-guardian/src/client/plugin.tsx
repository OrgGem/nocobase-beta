/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin, useAPIClient } from '@nocobase/client';
import React from 'react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { StartupGuardianPage } from '../shared/StartupGuardianPage';

const SETTINGS_KEY = 'plugin-startup-guardian';
const READ_PERMISSION = 'pm.plugin-startup-guardian.read';

function StartupGuardianClientPage() {
  const api = useAPIClient();
  const { t } = useTranslation('plugin-startup-guardian');
  const request = useCallback(
    (options: { url: string; method?: 'get' | 'post'; data?: Record<string, unknown> }) => api.request(options),
    [api],
  );
  return <StartupGuardianPage request={request} t={(key) => String(t(key))} />;
}

export class PluginStartupGuardianClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add(SETTINGS_KEY, {
      title: this.t('Startup Guardian'),
      icon: 'SafetyCertificateOutlined',
      Component: StartupGuardianClientPage,
      aclSnippet: READ_PERMISSION,
    });
  }

  async remove() {
    this.app.pluginSettingsManager.remove(SETTINGS_KEY);
  }
}

export default PluginStartupGuardianClient;
