import React, { useEffect, useState } from 'react';
import { Button, Popconfirm, Space, Table, Tag, message } from 'antd';
import { ReloadOutlined, DeleteOutlined } from '@ant-design/icons';
import { useAPIClient, useRequest } from '@nocobase/client';
import { useCarboneTranslation } from '../locale';
import { COLLECTION } from '../../shared/constants';

interface CacheRow {
  id: number;
  cacheKey: string;
  templateId?: number | null;
  carboneTemplateId?: string;
  format: string;
  sizeBytes?: number;
  hitCount?: number;
  lastHitAt?: string | null;
  expiresAt?: string | null;
  createdAt?: string;
}

/**
 * P3 cache-management UI. Lists rows in `carboneRenderCache` and lets an admin
 * drop individual rows or invalidate all rows for a given template via the
 * `carboneRenderCache:invalidate` action.
 */
export const CacheTab: React.FC = () => {
  const api = useAPIClient();
  const { t } = useCarboneTranslation();
  const [templateNames, setTemplateNames] = useState<Record<number, string>>({});

  const { data, loading, refresh } = useRequest<{ data: CacheRow[] }>(
    () =>
      api
        .resource(COLLECTION.renderCache)
        .list({ pageSize: 100, sort: ['-createdAt'] })
        .then((r: any) => r.data),
  );

  useEffect(() => {
    api
      .resource(COLLECTION.templates)
      .list({ pageSize: 200, fields: ['id', 'name'] })
      .then((r: any) => {
        const map: Record<number, string> = {};
        for (const row of r?.data?.data || []) map[row.id] = row.name;
        setTemplateNames(map);
      })
      .catch(() => undefined);
  }, [api]);

  const onDropRow = async (row: CacheRow) => {
    try {
      const r: any = await api
        .resource(COLLECTION.renderCache)
        .invalidate({ values: { cacheKey: row.cacheKey } });
      message.success(t('{{n}} cache row(s) removed', { n: r?.data?.removed ?? 1 }));
      refresh();
    } catch (err: any) {
      message.error(err?.message || t('Render failed'));
    }
  };

  const onDropTemplate = async (templateId: number) => {
    try {
      const r: any = await api
        .resource(COLLECTION.renderCache)
        .invalidate({ values: { templateId } });
      message.success(t('{{n}} cache row(s) removed', { n: r?.data?.removed ?? 0 }));
      refresh();
    } catch (err: any) {
      message.error(err?.message || t('Render failed'));
    }
  };

  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Button icon={<ReloadOutlined />} onClick={refresh}>
          {t('Refresh')}
        </Button>
      </Space>
      <Table<CacheRow>
        rowKey="id"
        loading={loading}
        dataSource={data?.data || []}
        pagination={{ pageSize: 20 }}
        columns={[
          {
            title: t('Templates'),
            dataIndex: 'templateId',
            width: 200,
            render: (id) => (id ? templateNames[id] || `#${id}` : <span style={{ color: '#aaa' }}>—</span>),
          },
          {
            title: t('Output format'),
            dataIndex: 'format',
            width: 100,
            render: (f) => <Tag>{f?.toUpperCase()}</Tag>,
          },
          {
            title: t('Cache key'),
            dataIndex: 'cacheKey',
            ellipsis: true,
            render: (v) => <code style={{ fontSize: 11 }}>{v?.slice(0, 16)}…</code>,
          },
          {
            title: t('Size'),
            dataIndex: 'sizeBytes',
            width: 100,
            render: (v) => (v ? `${(v / 1024).toFixed(1)} KB` : '—'),
          },
          {
            title: t('Hit count'),
            dataIndex: 'hitCount',
            width: 100,
          },
          {
            title: t('Last hit at'),
            dataIndex: 'lastHitAt',
            width: 160,
            render: (v) => (v ? new Date(v).toLocaleString() : '—'),
          },
          {
            title: t('Expires at'),
            dataIndex: 'expiresAt',
            width: 160,
            render: (v) => (v ? new Date(v).toLocaleString() : '—'),
          },
          {
            title: t('Actions'),
            key: 'actions',
            width: 220,
            render: (_, row) => (
              <Space wrap>
                <Popconfirm title={t('Invalidate cache')} onConfirm={() => onDropRow(row)}>
                  <Button size="small" danger icon={<DeleteOutlined />}>
                    {t('Invalidate cache')}
                  </Button>
                </Popconfirm>
                {row.templateId ? (
                  <Popconfirm
                    title={t('Invalidate all cache for this template?')}
                    onConfirm={() => onDropTemplate(row.templateId!)}
                  >
                    <Button size="small" danger>
                      {t('Invalidate template')}
                    </Button>
                  </Popconfirm>
                ) : null}
              </Space>
            ),
          },
        ]}
      />
    </div>
  );
};

export default CacheTab;
