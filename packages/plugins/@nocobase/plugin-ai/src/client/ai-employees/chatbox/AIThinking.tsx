/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { LoadingOutlined, SearchOutlined, BookOutlined } from '@ant-design/icons';
import { useT } from '../../locale';
import { Space, Spin } from 'antd';
import { useChatMessagesStore } from './stores/chat-messages';
import { useToken } from '@nocobase/client';
import { Typography } from 'antd';
const { Paragraph } = Typography;

export const AIThinking: React.FC<{ nickname: string }> = ({ nickname }) => {
  const t = useT();
  const webSearching = useChatMessagesStore.use.webSearching();
  const knowledgeBaseSearching = useChatMessagesStore.use.knowledgeBaseSearching();
  const { token } = useToken();

  const getStatusText = () => {
    if (knowledgeBaseSearching) {
      return t('AI is searching knowledge base', { nickname });
    }
    if (webSearching) {
      return t('AI is searching', { nickname });
    }
    return t('AI is thinking', { nickname });
  };

  return (
    <Space direction="vertical">
      <Space
        direction="horizontal"
        style={{
          color: token.colorTextDescription,
          fontStyle: 'italic',
        }}
      >
        <Spin indicator={<LoadingOutlined spin />} />
        {getStatusText()}
      </Space>
      {knowledgeBaseSearching && (
        <Paragraph>
          <blockquote>
            <BookOutlined /> {t('Retrieving relevant documents...')}
          </blockquote>
        </Paragraph>
      )}
      {webSearching?.query && (
        <Paragraph>
          <blockquote>
            <SearchOutlined /> {webSearching.query}
          </blockquote>
        </Paragraph>
      )}
    </Space>
  );
};
