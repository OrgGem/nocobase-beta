/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { Card, Space, Switch } from 'antd';
import { IconPicker, useAPIClient, useSystemSettings } from '@nocobase/client';
import { resolveSettingsSearchIcon } from '../shared/SettingsSearchInjector';
import { useSaveSystemSettingsOptions } from '../shared/useSaveSystemSettingsOptions';
import { useT } from './locale';

export const HelpSettingsPage: React.FC = () => {
  const api = useAPIClient();
  const t = useT();
  const systemSettings = useSystemSettings();
  const { currentOptions, loaded, saving, saveOptions } = useSaveSystemSettingsOptions(
    (config) => api.request(config),
    systemSettings,
    t,
  );
  const showHelp = currentOptions?.showHelp !== false;
  const enableAIChatResize = currentOptions?.enableAIChatResize === true;
  const enableSettingsSearch = currentOptions?.enableSettingsSearch !== false;
  const searchIcon = resolveSettingsSearchIcon(currentOptions?.settingsSearchIcon);

  const handleToggleHelp = (checked: boolean) => saveOptions({ showHelp: checked });
  const handleToggleAIChatResize = (checked: boolean) => saveOptions({ enableAIChatResize: checked });
  const handleToggleSettingsSearch = (checked: boolean) => saveOptions({ enableSettingsSearch: checked });
  const handleSearchIconChange = (nextIcon?: string | null) => saveOptions({ settingsSearchIcon: nextIcon ?? '' });

  return (
    <div style={{ padding: 24 }}>
      <Card title={t('Help')} style={{ marginBottom: 24 }}>
        <Space size="middle" align="center">
          <span>{t('Show help button in header')}</span>
          <Switch
            aria-label={t('Show help button in header')}
            checked={showHelp}
            disabled={!loaded}
            loading={saving}
            onChange={handleToggleHelp}
          />
        </Space>
      </Card>
      <Card title={t('AI Chat')} style={{ marginBottom: 24 }}>
        <Space size="middle" align="center">
          <span>{t('Enable AI chat resizing')}</span>
          <Switch
            aria-label={t('Enable AI chat resizing')}
            checked={enableAIChatResize}
            disabled={!loaded}
            loading={saving}
            onChange={handleToggleAIChatResize}
          />
        </Space>
      </Card>
      <Card title={t('Settings Search')}>
        <Space direction="vertical" size="middle">
          <Space size="middle" align="center">
            <span>{t('Enable settings search')}</span>
            <Switch
              aria-label={t('Enable settings search')}
              checked={enableSettingsSearch}
              disabled={!loaded}
              loading={saving}
              onChange={handleToggleSettingsSearch}
            />
          </Space>
          <Space size="middle" align="center">
            <span>{t('Search icon')}</span>
            <IconPicker
              value={searchIcon || undefined}
              disabled={!loaded || saving}
              onChange={handleSearchIconChange}
            />
          </Space>
        </Space>
      </Card>
    </div>
  );
};

export default HelpSettingsPage;
