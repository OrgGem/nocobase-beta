import React, { useState } from 'react';
import { Card, Space, Switch, message } from 'antd';
import { useAPIClient, useSystemSettings } from '@nocobase/client';
import { useT } from './locale';

export const HelpSettingsPage: React.FC = () => {
  const api = useAPIClient();
  const t = useT();
  const systemSettings = useSystemSettings();
  const showHelp = systemSettings?.data?.data?.options?.showHelp !== false;
  const [saving, setSaving] = useState(false);

  const handleToggleHelp = async (checked: boolean) => {
    setSaving(true);
    try {
      const options = {
        ...systemSettings?.data?.data?.options,
        showHelp: checked,
      };

      await api.request({
        url: 'systemSettings:put',
        method: 'post',
        data: { options },
      });

      if (systemSettings?.mutate) {
        systemSettings.mutate({
          data: {
            ...systemSettings.data?.data,
            options,
          },
        });
      }

      message.success(t('Saved successfully'));
    } catch (error) {
      console.error('[HelpSettings] Failed to save help setting:', error);
      message.error(t('Save failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: 24 }}>
      <Card title={t('Help')} style={{ marginBottom: 24 }}>
        <Space size="middle" align="center">
          <span>{t('Show help button in header')}</span>
          <Switch checked={showHelp} loading={saving} onChange={handleToggleHelp} />
        </Space>
      </Card>
    </div>
  );
};

export default HelpSettingsPage;
