// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Card, Space, Switch } from 'antd';
import { useApp, useSystemSettings } from '@nocobase/client-v2';
import { useSaveSystemSettingsOptions } from '../shared/useSaveSystemSettingsOptions';

export const AIChatSettingsPage: React.FC = () => {
  const app = useApp();
  const t = (key: string) => app.i18n.t(key, { ns: 'plugin-advance-settings' });
  const systemSettings = useSystemSettings();
  const { currentOptions, loaded, saving, saveOptions } = useSaveSystemSettingsOptions(
    (config) => app.apiClient.request(config),
    systemSettings,
    t,
  );
  const enableAIChatResize = currentOptions?.enableAIChatResize === true;
  const handleToggle = (checked: boolean) => saveOptions({ enableAIChatResize: checked });

  return (
    <div style={{ padding: 24 }}>
      <Card title={t('AI Chat')}>
        <Space size="middle" align="center">
          <span>{t('Enable AI chat resizing')}</span>
          <Switch
            aria-label={t('Enable AI chat resizing')}
            checked={enableAIChatResize}
            disabled={!loaded}
            loading={saving}
            onChange={handleToggle}
          />
        </Space>
      </Card>
    </div>
  );
};

export default AIChatSettingsPage;
