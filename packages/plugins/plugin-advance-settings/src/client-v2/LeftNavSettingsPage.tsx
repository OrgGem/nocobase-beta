// SPDX-License-Identifier: Apache-2.0

import React, { useId } from 'react';
import { Card, Space, Switch } from 'antd';
import { useApp, useSystemSettings } from '@nocobase/client-v2';
import { useSaveSystemSettingsOptions } from '../shared/useSaveSystemSettingsOptions';

export const LeftNavSettingsPage: React.FC = () => {
  const app = useApp();
  const t = (key: string) => app.i18n.t(key, { ns: 'plugin-advance-settings' });
  const systemSettings = useSystemSettings();
  const labelId = useId();
  const { currentOptions, loaded, saving, saveOptions } = useSaveSystemSettingsOptions(
    (config) => app.apiClient.request(config),
    systemSettings,
    t,
  );
  const enableLeftNavResize = currentOptions?.enableLeftNavResize === true;
  const handleToggle = (checked: boolean) => saveOptions({ enableLeftNavResize: checked });

  return (
    <div style={{ padding: 24 }}>
      <Card title={t('Left Navigator')}>
        <Space size="middle" align="center">
          <span id={labelId}>{t('Enable left navigator resizing')}</span>
          <Switch
            aria-labelledby={labelId}
            checked={enableLeftNavResize}
            disabled={!loaded}
            loading={saving}
            onChange={handleToggle}
          />
        </Space>
      </Card>
    </div>
  );
};

export default LeftNavSettingsPage;
