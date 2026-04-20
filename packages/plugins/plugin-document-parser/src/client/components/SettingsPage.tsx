/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { Tabs } from 'antd';
import { SettingOutlined, ApiOutlined } from '@ant-design/icons';
import { GlobalSettings } from './GlobalSettings';
import { ProviderList } from './ProviderList';
import { useDocParserTranslation } from '../locale';

export const SettingsPage: React.FC = () => {
  const { t } = useDocParserTranslation();

  const items = [
    {
      key: 'global',
      label: (
        <span>
          <SettingOutlined />
          {t('Global Settings')}
        </span>
      ),
      children: <GlobalSettings />,
    },
    {
      key: 'providers',
      label: (
        <span>
          <ApiOutlined />
          {t('OCR Providers')}
        </span>
      ),
      children: (
        <div style={{ padding: '8px 0' }}>
          <ProviderList />
        </div>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Tabs items={items} defaultActiveKey="global" />
    </div>
  );
};
