import { useFlowContext } from '@nocobase/flow-engine';
import { useRequest } from 'ahooks';
import { Card, Space, Table, Tag, Typography } from 'antd';
import React, { useState } from 'react';
import { fetchStatistics, unwrapResponse, type CollectionStats } from '../api/database-plus';
import { useT } from '../locale';

const { Text } = Typography;

interface CollectionSummary {
  name: string;
  title: string;
  tableName: string;
  estimatedRowCount: number | null;
}

function viewLabel(view: unknown): string {
  if (typeof view === 'string') return view;
  if (view && typeof view === 'object') {
    const value = view as Record<string, unknown>;
    return String(value.name ?? value.viewname ?? value.viewName ?? value.table_name ?? 'view');
  }
  return String(view);
}

export default function StatisticsPane() {
  const ctx = useFlowContext();
  const t = useT();
  const api = ctx.api;

  const [detail, setDetail] = useState<CollectionStats>();
  const [views, setViews] = useState<unknown[]>([]);

  const { data: summaries, loading } = useRequest(async () =>
    unwrapResponse<{ collections: CollectionSummary[] }>(await fetchStatistics(api, '')),
  );

  const { run: loadDetail, loading: loadingDetail } = useRequest(
    async (name: string) =>
      unwrapResponse<{ collection: CollectionStats; views: unknown[] }>(await fetchStatistics(api, name)),
    {
      manual: true,
      onSuccess: (result) => {
        setDetail(result.collection);
        setViews(Array.isArray(result.views) ? result.views : []);
      },
    },
  );

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card title={t('Collections')} size="small">
        <Table<CollectionSummary>
          rowKey="name"
          loading={loading}
          size="small"
          dataSource={summaries?.collections ?? []}
          onRow={(record) => ({ onClick: () => loadDetail(record.name), style: { cursor: 'pointer' } })}
          columns={[
            { title: t('Title'), dataIndex: 'title', key: 'title' },
            { title: t('Name'), dataIndex: 'name', key: 'name' },
            { title: t('Table name'), dataIndex: 'tableName', key: 'tableName' },
            {
              title: t('Estimated row count'),
              dataIndex: 'estimatedRowCount',
              key: 'estimatedRowCount',
              render: (value: number | null) => (value === null ? '—' : value),
            },
          ]}
        />
      </Card>

      {detail ? (
        <Card title={detail.name} size="small" loading={loadingDetail}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Space wrap>
              <Tag>{`${t('Table name')}: ${detail.tableName}`}</Tag>
              <Tag color={detail.tableExists ? 'green' : 'red'}>
                {detail.tableExists ? t('Table exists') : t('Table missing')}
              </Tag>
              {detail.primaryKey ? <Tag>{`PK: ${detail.primaryKey}`}</Tag> : null}
            </Space>
            <Text>
              {t('Estimated row count')}: {detail.estimatedRowCount ?? '—'} · {t('Row count')}: {detail.rowCount ?? '—'}
            </Text>
            {detail.autoIncrement ? (
              <Text>
                {t('Auto increment')}: {detail.autoIncrement.currentVal}
              </Text>
            ) : null}
            {views.length ? (
              <div>
                <Text strong>{t('Views')}</Text>
                <div style={{ marginTop: 8 }}>
                  {(views as unknown[]).map((view, index) => (
                    <Tag key={index}>{viewLabel(view)}</Tag>
                  ))}
                </div>
              </div>
            ) : null}
          </Space>
        </Card>
      ) : null}
    </Space>
  );
}
