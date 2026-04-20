/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Ant Design Menu demo — Collapsed sidebar mode
 */

import { AppstoreOutlined, MailOutlined, SettingOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Menu } from 'antd';
import React from 'react';

import type { ComponentDemo } from '../../interface';

type MenuItem = Required<MenuProps>['items'][number];

const items: MenuItem[] = [
  { key: '1', icon: <MailOutlined />, label: 'Nav 1' },
  { key: '2', icon: <AppstoreOutlined />, label: 'Nav 2' },
  { key: '3', icon: <SettingOutlined />, label: 'Nav 3' },
];

const Demo: React.FC = () => {
  return (
    <div style={{ width: 80 }}>
      <Menu defaultSelectedKeys={['1']} mode="inline" inlineCollapsed={true} items={items} />
    </div>
  );
};

const componentDemo: ComponentDemo = {
  demo: <Demo />,
  tokens: ['colorPrimary', 'colorBgContainer', 'colorText'],
  key: 'collapsed',
};

export default componentDemo;
