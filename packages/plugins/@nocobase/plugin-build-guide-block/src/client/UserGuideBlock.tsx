import React from 'react';
import { Card, Spin } from 'antd';
import { useRequest } from '@nocobase/client';
import { observer } from '@formily/react';
import { useTranslation } from 'react-i18next';
import DOMPurify from 'dompurify';

export const UserGuideBlock = observer(
  (props: any) => {
    const { spaceId } = props;
    const { t } = useTranslation();

    const { loading, data: htmlContent } = useRequest(
      {
        url: `aiBuildGuideSpaces:getHtml/${spaceId}`,
      },
      {
        refreshDeps: [spaceId],
        ready: !!spaceId,
      }
    );

    if (!spaceId) {
      return (
        <Card style={{ padding: 24, textAlign: 'center', color: '#888' }}>
          {t('Please select a User Guide Space in block settings')}
        </Card>
      );
    }

    if (loading) {
      return (
        <Card style={{ padding: 24, textAlign: 'center' }}>
          <Spin size="large" />
        </Card>
      );
    }

    return (
      <Card
        bordered={false}
        className="user-guide-block"
        style={{ width: '100%', minHeight: 300 }}
      >
        <div
          className="user-guide-content"
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize((htmlContent as any)?.data || '') }}
        />
      </Card>
    );
  },
  { displayName: 'UserGuideBlock' }
);
