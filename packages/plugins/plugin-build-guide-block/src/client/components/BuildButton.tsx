/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Button, App } from 'antd';
import { useAPIClient, useCollectionRecordData, useDataBlockRequest } from '@nocobase/client';
import { PlayCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { namespace } from '../locale';

const POLL_INTERVAL_MS = 3000;
const SAFE_ERROR_CODES = new Set([
  'BUILD_FAILED',
  'WORKFLOW_UNAVAILABLE',
  'SOURCE_ACCESS_DENIED',
  'INVALID_PLAN',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_FAILED',
  'PUBLISH_FAILED',
  'UNKNOWN_OUTCOME',
  'CANCELLED',
]);
type ID = string | number;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readApiData(response: unknown): unknown {
  if (!isRecord(response)) return response;
  const envelope = response.data;
  if (!isRecord(envelope)) return envelope ?? response;
  return envelope.data ?? envelope;
}

function isId(value: unknown): value is ID {
  return typeof value === 'string' || typeof value === 'number';
}

function safeErrorMessage(error: unknown, t: (key: string) => string) {
  if (
    isRecord(error) &&
    isRecord(error.response) &&
    isRecord(error.response.data) &&
    isRecord(error.response.data.error)
  ) {
    const code = error.response.data.error.code;
    if (typeof code === 'string' && SAFE_ERROR_CODES.has(code)) return t(code);
  }
  return t('Build failed');
}

export const BuildButton = () => {
  const [loading, setLoading] = useState(false);
  const api = useAPIClient();
  const { message } = App.useApp();
  const { t } = useTranslation([namespace, 'client']);
  const record = useCollectionRecordData();
  const { refresh } = useDataBlockRequest();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordId = isRecord(record) && isId(record.id) ? record.id : undefined;
  const activeRunId = isRecord(record) && isId(record.activeRunId) ? record.activeRunId : undefined;
  const isBuilding = activeRunId != null || (isRecord(record) && record.status === 'building');

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleBuild = async () => {
    if (recordId == null) return;
    setLoading(true);
    try {
      const response: unknown = await api.resource('aiBuildGuideSpaces').build({ filterByTk: recordId });
      const result = readApiData(response);
      const runId = isRecord(result) && isId(result.runId) ? result.runId : undefined;
      if (runId == null) {
        setLoading(false);
        message.error(t('Build failed'));
        return;
      }
      message.success(t('Build started'));

      const poll = async () => {
        try {
          const runResponse: unknown = await api.resource('aiBuildGuideRuns').getStatus({ filterByTk: runId });
          const run = readApiData(runResponse);
          const status = isRecord(run) && typeof run.status === 'string' ? run.status : undefined;
          if (status && !['queued', 'running'].includes(status)) {
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = null;
            setLoading(false);
            refresh?.();
            if (status === 'completed') message.success(t('Build completed'));
            else {
              const errorCode = isRecord(run) && typeof run.errorCode === 'string' ? run.errorCode : undefined;
              message.error(errorCode && SAFE_ERROR_CODES.has(errorCode) ? t(errorCode) : t('Build failed'));
            }
            return;
          }
          timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
        } catch {
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = null;
          setLoading(false);
          refresh?.();
        }
      };

      timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
    } catch (error: unknown) {
      message.error(safeErrorMessage(error, t));
      setLoading(false);
    }
  };

  return (
    <Button
      type="primary"
      icon={<PlayCircleOutlined />}
      loading={loading}
      onClick={handleBuild}
      disabled={recordId == null || isBuilding}
    >
      {t('Build')}
    </Button>
  );
};
