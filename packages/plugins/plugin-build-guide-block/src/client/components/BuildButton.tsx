import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Button, App } from 'antd';
import { useAPIClient, useCollectionRecordData, useDataBlockRequest } from '@nocobase/client';
import { PlayCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_COUNT = 100; // ~5 minutes max

export const BuildButton = () => {
  const [loading, setLoading] = useState(false);
  const api = useAPIClient();
  const { message } = App.useApp();
  const { t } = useTranslation();
  const record = useCollectionRecordData();
  const { refresh } = useDataBlockRequest();
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setLoading(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => stopPolling, [stopPolling]);

  const handleBuild = async () => {
    if (!record?.id) return;
    setLoading(true);
    try {
      await api.resource('aiBuildGuideSpaces').build({
        filterByTk: record.id,
      });
      message.success(t('Build started'));

      // Poll until status leaves "building"
      let pollCount = 0;
      timerRef.current = setInterval(async () => {
        pollCount++;
        try {
          const res = await api.resource('aiBuildGuideSpaces').get({ filterByTk: record.id });
          const status = res?.data?.data?.status;
          if (status !== 'building' || pollCount >= MAX_POLL_COUNT) {
            stopPolling();
            refresh?.();
            if (status === 'completed') {
              message.success(t('Build completed'));
            } else if (status === 'error') {
              message.error(t('Build failed'));
            }
          }
        } catch {
          stopPolling();
          refresh?.();
        }
      }, POLL_INTERVAL_MS);
    } catch (err: any) {
      console.error(err);
      message.error(err?.response?.data?.error?.message || t('Build failed'));
      setLoading(false);
    }
  };

  return (
    <Button
      type="primary"
      icon={<PlayCircleOutlined />}
      loading={loading}
      onClick={handleBuild}
      disabled={record?.status === 'building'}
    >
      {t('Build')}
    </Button>
  );
};
