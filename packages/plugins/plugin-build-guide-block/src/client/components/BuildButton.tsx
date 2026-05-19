import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Button, App } from 'antd';
import { useAPIClient, useCollectionRecordData, useDataBlockRequest } from '@nocobase/client';
import { PlayCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

const POLL_INTERVAL_MS = 3000;
const STILL_RUNNING_AFTER_MS = 5 * 60 * 1000;
const SLOW_POLL_INTERVAL_MS = 10000;

export const BuildButton = () => {
  const [loading, setLoading] = useState(false);
  const api = useAPIClient();
  const { message } = App.useApp();
  const { t } = useTranslation();
  const record = useCollectionRecordData();
  const { refresh } = useDataBlockRequest();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
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

      const startedAt = Date.now();
      let stillRunningNotified = false;
      const poll = async () => {
        try {
          const res = await api.resource('aiBuildGuideSpaces').get({ filterByTk: record.id });
          const status = res?.data?.data?.status;
          if (status !== 'building') {
            stopPolling();
            refresh?.();
            if (status === 'completed') {
              message.success(t('Build completed'));
            } else if (status === 'error') {
              message.error(t('Build failed'));
            }
            return;
          }

          const elapsed = Date.now() - startedAt;
          if (elapsed >= STILL_RUNNING_AFTER_MS && !stillRunningNotified) {
            stillRunningNotified = true;
            message.info(t('Build is still running'));
          }
          const nextPollDelay = elapsed >= STILL_RUNNING_AFTER_MS ? SLOW_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
          timerRef.current = setTimeout(poll, nextPollDelay);
        } catch {
          stopPolling();
          refresh?.();
        }
      };

      timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
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
