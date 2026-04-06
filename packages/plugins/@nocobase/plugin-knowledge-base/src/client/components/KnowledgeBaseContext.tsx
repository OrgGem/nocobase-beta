/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { BookOutlined } from '@ant-design/icons';
import { Space, Popover } from 'antd';
import { KnowledgeBaseSelector } from './KnowledgeBaseSelector';

export type WorkContextOptions = {
  name?: string;
  menu?: {
    icon?: React.ReactNode;
    label?: React.ReactNode;
    Component?: React.ComponentType<any>;
    onClick?: (props: any) => void;
  };
  tag?: {
    Component: React.ComponentType<{ item: any }>;
  };
  getContent?: (app: any, item: any) => Promise<any>;
};

export const KnowledgeBaseContext: WorkContextOptions = {
  name: 'knowledge-base',
  menu: {
    icon: <BookOutlined />,
    label: 'Knowledge Base',
    onClick: ({ ctx, contextItems, onAdd, onRemove }) => {
      ctx.viewer.dialog({
        width: 900,
        content: (
          <KnowledgeBaseSelector
            contextItems={contextItems}
            onAdd={onAdd}
            onRemove={onRemove}
            onClose={() => ctx.viewer.close()}
          />
        ),
      });
    },
  },
  tag: {
    Component: ({ item }) => {
      return (
        <Space>
          <BookOutlined />
          <span>{item?.title || 'Knowledge Base'}</span>
        </Space>
      );
    },
  },
  getContent: async (_app, { uid, content }) => {
    return content || { knowledgeBaseId: uid };
  },
};
