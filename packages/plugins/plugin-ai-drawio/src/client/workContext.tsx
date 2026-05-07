import React from 'react';
import { ApartmentOutlined } from '@ant-design/icons';
import { Space, message } from 'antd';
import { i18n } from '@nocobase/client';
type WorkContextOptions = any;
import { getHandleByUid, getAllHandles } from './lib/activeRegistry';
import { namespace, useT } from './locale';

type DrawioContextItemContent = {
  diagramId?: string;
  diagramTitle?: string;
};

const tNs = (key: string) => (i18n?.t ? (i18n.t(key, { ns: [namespace, 'client'] }) as string) : key);

export const DrawioWorkContext: WorkContextOptions = {
  name: 'drawio',
  menu: {
    icon: <ApartmentOutlined />,
    Component: () => {
      const t = useT();
      return <span>{t('Drawio Diagram')}</span>;
    },
    onClick: ({ contextItems, onAdd }) => {
      const handles = getAllHandles();
      if (handles.length === 0) {
        message.info(tNs('No drawio diagram is currently open on the page.'));
        return;
      }
      const existingUids = new Set((contextItems || []).map((it) => it.uid));
      let added = 0;
      for (const handle of handles) {
        if (existingUids.has(handle.blockUid)) continue;
        onAdd({
          uid: handle.blockUid,
          title: handle.diagramTitle || `${tNs('Diagram')} ${handle.diagramId}`,
        });
        added++;
      }
      if (added === 0) {
        message.info(tNs('Drawio diagram already attached to this chat.'));
      }
    },
  },
  tag: {
    Component: ({ item }) => (
      <Space>
        <ApartmentOutlined />
        <span>{item.title || tNs('Drawio Diagram')}</span>
      </Space>
    ),
  },
  getContent: async (_app, item) => {
    const handle = getHandleByUid(item.uid);
    if (!handle) {
      return `Drawio diagram "${item.title || item.uid}" is not currently mounted on the page.`;
    }
    const xml = handle.getXml() || '';
    const meta = item.content as DrawioContextItemContent | undefined;
    const title = meta?.diagramTitle || handle.diagramTitle || item.title;
    const titleLine = title ? `Title: ${title}\n` : '';
    return (
      `${titleLine}Current diagram XML (AUTHORITATIVE - the source of truth on the canvas right now). ` +
      `When using edit_diagram, COPY cell IDs and attribute order EXACTLY from this XML.\n\n` +
      '```xml\n' +
      (xml || '<empty diagram>') +
      '\n```'
    );
  },
};
