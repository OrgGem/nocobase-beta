import { Alert, Select, Space, Table, Tag } from 'antd';
import React, { useEffect, useState } from 'react';
import { useApp } from '@nocobase/client-v2';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/errors';

export interface OperationRow {
  id: number;
  action: string;
  status: 'success' | 'error';
  algorithm?: string | null;
  keyId?: number | string | null;
  partnerKeyId?: number | string | null;
  inputBytes?: number | string | null;
  outputBytes?: number | string | null;
  inputSha256?: string | null;
  outputSha256?: string | null;
  inputAttachmentId?: number | string | null;
  outputAttachmentId?: number | string | null;
  durationMs?: number | null;
  errorMessage?: string | null;
  createdAt: string;
}

export interface RecentOperationsProps {
  refreshKey?: number;
  actionFilter?: string[];
}

const PAGE_SIZE = 10;

export const RecentOperations: React.FC<RecentOperationsProps> = ({ refreshKey = 0, actionFilter }) => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient;
  const [rows, setRows] = useState<OperationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'success' | 'error' | undefined>();
  // Content-based key so the effect does not refetch when the parent passes a
  // fresh array with the same contents on every render.
  const actionFilterKey = actionFilter?.join('|');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (actionFilterKey && actionFilterKey.length > 0) {
      const actions = actionFilterKey.split('|');
      filter.action = actions.length === 1 ? actions[0] : { $in: actions };
    }
    api
      .request({
        url: 'cryptoOperations:list',
        params: { paginate: false, sort: ['-createdAt'], filter },
      })
      .then((res) => {
        if (cancelled) return;
        const data = (res?.data?.data as OperationRow[] | undefined) ?? [];
        setRows(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(getErrorMessage(err, t('Failed to load operations') as string));
        setRows([]);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      })
      .catch(() => {
        // promise/catch-or-return guard for the finally chain
      });
    return () => {
      cancelled = true;
    };
  }, [api, t, status, refreshKey, actionFilterKey]);

  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        <Select
          allowClear
          placeholder={t('Filter by status') as string}
          style={{ width: 200 }}
          value={status}
          onChange={(v) => setStatus(v)}
          options={[
            { value: 'success', label: t('success') },
            { value: 'error', label: t('error') },
          ]}
        />
      </Space>
      {error && (
        <Alert type='error' message={error} showIcon style={{ marginBottom: 12 }} />
      )}
      <Table<OperationRow>
        rowKey="id"
        loading={loading}
        dataSource={rows}
        size="small"
        pagination={{ pageSize: PAGE_SIZE, showSizeChanger: false }}
        scroll={{ x: 900 }}
        columns={[
          { title: t('When'), dataIndex: 'createdAt', width: 180 },
          { title: t('Action'), dataIndex: 'action', width: 120 },
          {
            title: t('Status'),
            dataIndex: 'status',
            width: 100,
            render: (v: string) => <Tag color={v === 'success' ? 'green' : 'red'}>{t(v)}</Tag>,
          },
          { title: t('Algorithm'), dataIndex: 'algorithm', width: 100 },
          { title: t('Input size'), dataIndex: 'inputBytes', width: 110 },
          { title: t('Output size'), dataIndex: 'outputBytes', width: 110 },
          { title: t('Duration (ms)'), dataIndex: 'durationMs', width: 110 },
          {
            title: t('Error'),
            dataIndex: 'errorMessage',
            ellipsis: true,
            render: (v: string | null) =>
              v ? <span style={{ color: '#d4380d' }}>{v}</span> : <span style={{ color: '#bbb' }}>—</span>,
          },
        ]}
      />
    </div>
  );
};

export default RecentOperations;
