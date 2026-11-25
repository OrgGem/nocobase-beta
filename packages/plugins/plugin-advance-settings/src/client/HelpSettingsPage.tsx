/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useState } from 'react';
import { Card, Space, Switch, message } from 'antd';
import { useAPIClient, useSystemSettings } from '@nocobase/client';
import { useT } from './locale';

export const HelpSettingsPage: React.FC = () => {
  const api = useAPIClient();
  const t = useT();
  const systemSettings = useSystemSettings();
  const showHelp = systemSettings?.data?.data?.options?.showHelp !== false;
  const enableAIChatResize = systemSettings?.data?.data?.options?.enableAIChatResize === true;
  const [saving, setSaving] = useState(false);

  const handleToggle = async (key: 'showHelp' | 'enableAIChatResize', checked: boolean) => {
    setSaving(true);
    try {
      const options = {
        ...systemSettings?.data?.data?.options,
        [key]: checked,
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
      console.error('[AdvanceSettings] Failed to save setting:', error);
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
          <Switch
            aria-label={t('Show help button in header')}
            checked={showHelp}
            loading={saving}
            onChange={(checked) => handleToggle('showHelp', checked)}
          />
        </Space>
      </Card>
      <Card title={t('AI Chat')}>
        <Space size="middle" align="center">
          <span>{t('Enable AI chat resizing')}</span>
          <Switch
            aria-label={t('Enable AI chat resizing')}
            checked={enableAIChatResize}
            disabled={!systemSettings?.data?.data}
            loading={saving}
            onChange={(checked) => handleToggle('enableAIChatResize', checked)}
          />
        </Space>
      </Card>
    </div>
  );
};

export default HelpSettingsPage;
