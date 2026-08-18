import { Button, DatePicker, Descriptions, Drawer, Input, message, Select, Space, Table, Tag } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import dayjs, { Dayjs } from 'dayjs';
import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/errors';

interface LogRow {
  id: number;
  requestId?: string;
  routeId?: number;
  routeName?: string;
  direction?: string;
  method?: string;
  path?: string;
  partnerId?: number;
  apiKeyId?: number;
  clientIp?: string;
  userAgent?: string;
  status?: string;
  httpStatus?: number;
  upstreamStatus?: number;
  attempt?: number;
  errorCode?: string;
  error?: string;
  requestBytes?: number;
  responseBytes?: number;
  requestSha256?: string;
  responseSha256?: string;
  requestPayload?: string;
  responsePayload?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  createdAt?: string;
}

const STATUS_COLORS: Record<string, string> = {
  ok: 'green',
  rejected: 'orange',
  failed: 'red',
};

export const RequestLogsPage: React.FC = () => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient;

  const [rows, setRows] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [routeFilter, setRouteFilter] = useState<string | undefined>();
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [detail, setDetail] = useState<LogRow | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 20;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const filter: Record<string, unknown> = {};
      if (routeFilter) filter.routeName = routeFilter;
      if (statusFilter) filter.status = statusFilter;
      if (range && range[0] && range[1]) {
        filter.createdAt = { $gte: range[0].toISOString(), $lte: range[1].toISOString() };
      }
      const res = await api.request({
        url: 'apiRequestLogs:list',
        params: { page, pageSize, sort: ['-createdAt'], filter },
      });
      setRows((res?.data?.data ?? []) as LogRow[]);
      const meta = res?.data?.meta as { count?: number; totalPage?: number; pageSize?: number } | undefined;
      setTotal(meta?.count ?? (meta?.totalPage ?? 0) * (meta?.pageSize ?? pageSize));
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to load request logs') as string));
    } finally {
      setLoading(false);
    }
  }, [api, t, routeFilter, statusFilter, range, page]);

  useEffect(() => {
    load();
  }, [load]);

  const columns = [
    {
      title: t('Time') as string,
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (v?: string) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    { title: t('Route') as string, dataIndex: 'routeName', key: 'routeName' },
    {
      title: t('Direction') as string,
      dataIndex: 'direction',
      key: 'direction',
      render: (v?: string) => (v ? <Tag color={v === 'inbound' ? 'green' : 'geekblue'}>{v}</Tag> : '-'),
    },
    { title: t('Method') as string, dataIndex: 'method', key: 'method' },
    { title: t('Path') as string, dataIndex: 'path', key: 'path', ellipsis: true },
    {
      title: t('Status') as string,
      dataIndex: 'status',
      key: 'status',
      render: (v?: string) => <Tag color={STATUS_COLORS[v ?? ''] ?? 'default'}>{v ?? '-'}</Tag>,
    },
    { title: t('HTTP') as string, dataIndex: 'httpStatus', key: 'httpStatus' },
    {
      title: t('Duration (ms)') as string,
      dataIndex: 'durationMs',
      key: 'durationMs',
    },
    {
      title: t('Actions') as string,
      key: 'actions',
      render: (_: unknown, record: LogRow) => (
        <Button size="small" onClick={() => setDetail(record)}>
          {t('Detail')}
        </Button>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Input
          allowClear
          placeholder={t('Filter by route name') as string}
          value={routeFilter}
          onChange={(e) => {
            setPage(1);
            setRouteFilter(e.target.value || undefined);
          }}
          style={{ width: 200 }}
        />
        <Select
          allowClear
          placeholder={t('Status') as string}
          value={statusFilter}
          onChange={(v) => {
            setPage(1);
            setStatusFilter(v);
          }}
          options={['ok', 'rejected', 'failed'].map((s) => ({ value: s, label: s }))}
          style={{ width: 140 }}
        />
        <DatePicker.RangePicker
          showTime
          value={range as [Dayjs, Dayjs] | undefined}
          onChange={(v) => {
            setPage(1);
            setRange(v as [Dayjs | null, Dayjs | null] | null);
          }}
        />
        <Button icon={<ReloadOutlined />} onClick={load}>
          {t('Refresh')}
        </Button>
      </Space>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          onChange: (p) => setPage(p),
          showSizeChanger: false,
        }}
      />
      <Drawer
        title={`${t('Request Log') as string} #${detail?.id ?? ''}`}
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        width={640}
      >
        {detail && (
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label={t('Request ID') as string}>{detail.requestId ?? '-'}</Descriptions.Item>
            <Descriptions.Item label={t('Route') as string}>{detail.routeName ?? '-'}</Descriptions.Item>
            <Descriptions.Item label={t('Direction') as string}>{detail.direction ?? '-'}</Descriptions.Item>
            <Descriptions.Item label={t('Method') as string}>{detail.method ?? '-'}</Descriptions.Item>
            <Descriptions.Item label={t('Path') as string}>{detail.path ?? '-'}</Descriptions.Item>
            <Descriptions.Item label={t('Client IP') as string}>{detail.clientIp ?? '-'}</Descriptions.Item>
            <Descriptions.Item label={t('User Agent') as string}>{detail.userAgent ?? '-'}</Descriptions.Item>
            <Descriptions.Item label={t('Status') as string}>{detail.status ?? '-'}</Descriptions.Item>
            <Descriptions.Item label={t('HTTP Status') as string}>{detail.httpStatus ?? '-'}</Descriptions.Item>
            <Descriptions.Item label={t('Upstream Status') as string}>{detail.upstreamStatus ?? '-'}</Descriptions.Item>
            <Descriptions.Item label={t('Attempt') as string}>{detail.attempt ?? '-'}</Descriptions.Item>
            <Descriptions.Item label={t('Error Code') as string}>{detail.errorCode ?? '-'}</Descriptions.Item>
            <Descriptions.Item label={t('Error') as string}>{detail.error ?? '-'}</Descriptions.Item>
            <Descriptions.Item label={t('Request Bytes') as string}>{detail.requestBytes ?? '-'}</Descriptions.Item>
            <Descriptions.Item label={t('Response Bytes') as string}>{detail.responseBytes ?? '-'}</Descriptions.Item>
            <Descriptions.Item label={t('Request SHA-256') as string}>
              <code>{detail.requestSha256 ?? '-'}</code>
            </Descriptions.Item>
            <Descriptions.Item label={t('Response SHA-256') as string}>
              <code>{detail.responseSha256 ?? '-'}</code>
            </Descriptions.Item>
            <Descriptions.Item label={t('Started At') as string}>
              {detail.startedAt ? dayjs(detail.startedAt).format('YYYY-MM-DD HH:mm:ss.SSS') : '-'}
            </Descriptions.Item>
            <Descriptions.Item label={t('Finished At') as string}>
              {detail.finishedAt ? dayjs(detail.finishedAt).format('YYYY-MM-DD HH:mm:ss.SSS') : '-'}
            </Descriptions.Item>
            <Descriptions.Item label={t('Duration (ms)') as string}>{detail.durationMs ?? '-'}</Descriptions.Item>
            {detail.requestPayload != null && (
              <Descriptions.Item label={t('Request Payload') as string}>
                <pre style={{ maxHeight: 200, overflow: 'auto', margin: 0, fontSize: 12 }}>{detail.requestPayload}</pre>
              </Descriptions.Item>
            )}
            {detail.responsePayload != null && (
              <Descriptions.Item label={t('Response Payload') as string}>
                <pre style={{ maxHeight: 200, overflow: 'auto', margin: 0, fontSize: 12 }}>
                  {detail.responsePayload}
                </pre>
              </Descriptions.Item>
            )}
          </Descriptions>
        )}
      </Drawer>
    </div>
  );
};

export default RequestLogsPage;
