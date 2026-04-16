import React, { useState } from 'react';
import { Button, App } from 'antd';
import { useAPIClient, useCollectionRecordData, useDataBlockRequest } from '@nocobase/client';
import { PlayCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

export const BuildButton = () => {
  const [loading, setLoading] = useState(false);
  const api = useAPIClient();
  const { message } = App.useApp();
  const { t } = useTranslation();
  const record = useCollectionRecordData();
  const { refresh } = useDataBlockRequest();

  const handleBuild = async () => {
    if (!record?.id) return;
    setLoading(true);
    try {
      await api.resource('aiBuildGuideSpaces').build({
        filterByTk: record.id,
      });
      message.success(t('Build started'));
      // Delay slightly to allow background status update to propagate
      setTimeout(() => refresh?.(), 1500);
    } catch (err: any) {
      console.error(err);
      message.error(err?.response?.data?.error?.message || t('Build failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      type="primary"
      icon={<PlayCircleOutlined />}
      loading={loading}
      onClick={handleBuild}
    >
      {t('Build')}
    </Button>
  );
};
