import React from 'react';
import { GlobalOutlined } from '@ant-design/icons';
import { Space, message } from 'antd';
import { i18n } from '@nocobase/client';
import { namespace, useT } from './locale';
type WorkContextOptions = any;

type BrowserContextItemContent = {
  sessionId?: string;
  sessionTitle?: string;
};

const tNs = (key: string) => (i18n?.t ? (i18n.t(key, { ns: [namespace, 'client'] }) as string) : key);

/**
 * AIBrowserWorkContext — attaches current browser session to AI chat context.
 * Registered as a work context provider so the AI Employee can see the session state.
 */
export const AIBrowserWorkContext: WorkContextOptions = {
  name: 'browser',
  menu: {
    icon: <GlobalOutlined />,
    Component: () => {
      const t = useT();
      return <span>{t('Browser Session')}</span>;
    },
    onClick: ({ contextItems, onAdd }: any) => {
      // TODO: Integrate with session registry when live sessions available
      message.info(tNs('No active browser session'));
    },
  },
  tag: {
    Component: ({ item }: any) => (
      <Space>
        <GlobalOutlined />
        <span>{item.title || tNs('Browser Session')}</span>
      </Space>
    ),
  },
  getContent: async (_app: any, item: any) => {
    const meta = item.content as BrowserContextItemContent | undefined;
    const title = meta?.sessionTitle || item.title || 'Unknown';
    const sessionId = meta?.sessionId || item.uid;

    return (
      `Browser Session: ${title}\n` +
      `Session ID: ${sessionId}\n` +
      `This browser session is currently attached to the chat. Use browser_get_session to get details, ` +
      `or browser_read_page to inspect the current page before the next browser action.`
    );
  },
};
