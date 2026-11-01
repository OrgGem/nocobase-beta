import { BookOutlined } from '@ant-design/icons';
import type { AIManager } from '@nocobase/plugin-ai/client-v2';
import { Space } from 'antd';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { KnowledgeBaseSelector } from '../client/components/KnowledgeBaseSelector';

type WorkContextOptions = Parameters<AIManager['registerWorkContext']>[1];

function ContextLabel({ title }: { title?: string }) {
  const { t } = useTranslation('plugin-knowledge-base');
  return (
    <Space>
      <BookOutlined />
      <span>{title || t('Knowledge base')}</span>
    </Space>
  );
}

export const KnowledgeBaseContext: WorkContextOptions = {
  name: 'knowledge-base',
  menu: {
    icon: <BookOutlined />,
    Component: () => <ContextLabel />,
    onClick: ({ ctx, contextItems, onAdd, onRemove }) => {
      ctx.viewer.dialog({
        width: 900,
        content: (view) => (
          <KnowledgeBaseSelector
            contextItems={contextItems}
            onAdd={onAdd}
            onRemove={onRemove}
            onClose={() => view.close()}
          />
        ),
      });
    },
  },
  tag: { Component: ({ item }) => <ContextLabel title={item.title} /> },
  getContent: async (_app, { uid, content }) => content || { knowledgeBaseId: uid },
};
