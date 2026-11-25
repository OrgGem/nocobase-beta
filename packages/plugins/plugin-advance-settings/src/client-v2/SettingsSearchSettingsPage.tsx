// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Card, Space, Switch } from 'antd';
import { IconPicker, useApp, useSystemSettings } from '@nocobase/client-v2';
import { resolveSettingsSearchIcon } from '../shared/SettingsSearchInjector';
import { useSaveSystemSettingsOptions } from '../shared/useSaveSystemSettingsOptions';

export const SettingsSearchSettingsPage: React.FC = () => {
  const app = useApp();
  const t = (key: string) => app.i18n.t(key, { ns: 'plugin-advance-settings' });
  const systemSettings = useSystemSettings();
  const { currentOptions, loaded, saving, saveOptions } = useSaveSystemSettingsOptions(
    (config) => app.apiClient.request(config),
    systemSettings,
    t,
  );
  const enableSettingsSearch = currentOptions?.enableSettingsSearch !== false;
  const searchIcon = resolveSettingsSearchIcon(currentOptions?.settingsSearchIcon);

  const handleToggle = (checked: boolean) => saveOptions({ enableSettingsSearch: checked });
  const handleIconChange = (nextIcon?: string | null) => saveOptions({ settingsSearchIcon: nextIcon ?? '' });

  return (
    <div style={{ padding: 24 }}>
      <Card title={t('Settings Search')}>
        <Space direction="vertical" size="middle">
          <Space size="middle" align="center">
            <span>{t('Enable settings search')}</span>
            <Switch
              aria-label={t('Enable settings search')}
              checked={enableSettingsSearch}
              disabled={!loaded}
              loading={saving}
              onChange={handleToggle}
            />
          </Space>
          <Space size="middle" align="center">
            <span>{t('Search icon')}</span>
            <IconPicker value={searchIcon || undefined} disabled={!loaded || saving} onChange={handleIconChange} />
          </Space>
        </Space>
      </Card>
    </div>
  );
};

export default SettingsSearchSettingsPage;
