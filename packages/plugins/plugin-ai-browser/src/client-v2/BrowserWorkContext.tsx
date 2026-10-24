import { GlobalOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import type { AIManager } from '@nocobase/plugin-ai/client-v2';
import { useRequest } from 'ahooks';
import { Alert, Button, List, Space } from 'antd';
import React, { useState } from 'react';
import { useT } from './locale';
import type { BrowserSession } from './session';

type WorkContextOptions = Parameters<AIManager['registerWorkContext']>[1];
function ContextLabel({ title }: { title?: string }) {
  const t = useT();
  return (
    <Space>
      <GlobalOutlined />
      <span>{title || t('Browser Session')}</span>
    </Space>
  );
}
function BrowserPicker({
  ctx,
  contextItems,
  onAdd,
  onRemove,
}: Parameters<NonNullable<NonNullable<WorkContextOptions['menu']>['onClick']>>[0]) {
  const api = useApp().apiClient;
  const t = useT();
  const ownerId = ctx.user?.id;
  const [selectedIds, setSelectedIds] = useState(
    () => new Set(contextItems?.filter((item) => item.type === 'browser').map((item) => item.uid)),
  );
  const list = useRequest(
    async () => {
      const response = await api.request<{ data: BrowserSession[] }>({
        url: 'aiBrowserSessions:list',
        method: 'get',
        params: { filter: { status: 'running', ownerId }, pageSize: 50, sort: ['-createdAt'] },
      });
      return response.data.data;
    },
    { ready: ownerId != null, refreshDeps: [ownerId] },
  );
  return (
    <>
      {list.error && <Alert type="error" showIcon message={t('Failed to load browser sessions')} />}
      <List
        loading={list.loading}
        dataSource={list.data || []}
        locale={{ emptyText: t('No active browser session') }}
        renderItem={(session) => {
          const selected = selectedIds.has(session.id);
          return (
            <List.Item
              actions={[
                <Button
                  key="toggle"
                  onClick={() => {
                    if (selected) onRemove(session.id);
                    else
                      onAdd({
                        uid: session.id,
                        title: session.title || session.id,
                        content: { sessionId: session.id, sessionTitle: session.title },
                      });
                    setSelectedIds((previous) => {
                      const next = new Set(previous);
                      if (selected) next.delete(session.id);
                      else next.add(session.id);
                      return next;
                    });
                  }}
                >
                  {t(selected ? 'Remove' : 'Add')}
                </Button>,
              ]}
            >
              <ContextLabel title={session.title || session.currentUrl || session.id} />
            </List.Item>
          );
        }}
      />
    </>
  );
}

export const BrowserWorkContext: WorkContextOptions = {
  name: 'browser',
  menu: {
    icon: <GlobalOutlined />,
    Component: () => <ContextLabel />,
    onClick: (props) => {
      props.ctx.viewer.dialog({
        width: 720,
        title: props.ctx.t('Browser Session', { ns: 'plugin-ai-browser' }),
        content: () => <BrowserPicker {...props} />,
      });
    },
  },
  tag: { Component: ({ item }) => <ContextLabel title={item.title} /> },
  getContent: async (_app, item) => {
    const content = item.content && typeof item.content === 'object' ? (item.content as Record<string, unknown>) : {};
    return `Browser Session: ${content.sessionTitle || item.title || item.uid}\nSession ID: ${
      content.sessionId || item.uid
    }\nThis browser session is currently attached to the chat. Use browser_get_session to get details, or browser_read_page to inspect the current page before the next browser action.`;
  },
};
