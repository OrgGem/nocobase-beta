// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { Card, Space, Switch, message } from 'antd';
import { useApp, useSystemSettings } from '@nocobase/client-v2';

export const AIChatSettingsPage: React.FC = () => {
  const app = useApp();
  const t = (key: string) => app.i18n.t(key, { ns: 'plugin-advance-settings' });
  const systemSettings = useSystemSettings();
  const enableAIChatResize = systemSettings?.data?.data?.options?.enableAIChatResize === true;
  const [saving, setSaving] = useState(false);

  const handleToggle = async (checked: boolean) => {
    setSaving(true);
    try {
      const options = {
        ...systemSettings?.data?.data?.options,
        enableAIChatResize: checked,
      };
      await app.apiClient.request({
        url: 'systemSettings:put',
        method: 'post',
        data: { options },
      });
      systemSettings?.mutate?.({
        data: {
          ...systemSettings.data?.data,
          options,
        },
      });
      message.success(t('Saved successfully'));
    } catch (error) {
      console.error('[AdvanceSettings] Failed to save AI chat setting:', error);
      message.error(t('Save failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: 24 }}>
      <Card title={t('AI Chat')}>
        <Space size="middle" align="center">
          <span>{t('Enable AI chat resizing')}</span>
          <Switch
            aria-label={t('Enable AI chat resizing')}
            checked={enableAIChatResize}
            disabled={!systemSettings?.data?.data}
            loading={saving}
            onChange={handleToggle}
          />
        </Space>
      </Card>
    </div>
  );
};

export default AIChatSettingsPage;
