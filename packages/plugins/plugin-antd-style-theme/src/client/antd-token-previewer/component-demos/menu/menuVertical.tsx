/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Ant Design Menu demo — Vertical popup mode
 */

import type { MenuProps } from 'antd';
import { Menu } from 'antd';
import React from 'react';

import items from './data';

import type { ComponentDemo } from '../../interface';

const Demo: React.FC = () => {
  const onClick: MenuProps['onClick'] = (e) => {
    console.log('click ', e);
  };

  return (
    <div>
      <Menu onClick={onClick} style={{ width: 256 }} selectedKeys={['1']} mode="vertical" items={items} />
    </div>
  );
};

const componentDemo: ComponentDemo = {
  demo: <Demo />,
  tokens: ['colorPrimary', 'colorBgContainer', 'colorBgElevated', 'boxShadowSecondary'],
  key: 'vertical',
};

export default componentDemo;
