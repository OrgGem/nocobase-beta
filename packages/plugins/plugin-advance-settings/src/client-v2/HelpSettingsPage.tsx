// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Card, Space, Switch } from 'antd';
import { useApp, useSystemSettings } from '@nocobase/client-v2';
import { useSaveSystemSettingsOptions } from '../shared/useSaveSystemSettingsOptions';

export const HelpSettingsPage: React.FC = () => {
  const app = useApp();
  const t = (key: string) => app.i18n.t(key, { ns: 'plugin-advance-settings' });
  const systemSettings = useSystemSettings();
  const { currentOptions, loaded, saving, saveOptions } = useSaveSystemSettingsOptions(
    (config) => app.apiClient.request(config),
    systemSettings,
    t,
  );
  const showHelp = currentOptions?.showHelp !== false;
  const handleToggleHelp = (checked: boolean) => saveOptions({ showHelp: checked });

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
    </div>
  );
};

export default HelpSettingsPage;
