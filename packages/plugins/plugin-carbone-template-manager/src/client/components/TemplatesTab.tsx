import React, { useState } from 'react';
import { Button, Input, Popconfirm, Space, Table, Tag, message } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useAPIClient, useRequest } from '@nocobase/client';
import { useCarboneTranslation } from '../locale';
import { COLLECTION } from '../../shared/constants';
import { TemplateUploadModal } from './TemplateUploadModal';
import { VersionHistory } from './VersionHistory';

interface TemplateRow {
  id: number;
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  defaultOutputFormat?: string;
  enabled: boolean;
  carboneTemplateId?: string;
  currentVersionId?: number | null;
  originalFileName?: string;
  fileSize?: number;
  updatedAt: string;
}

export const TemplatesTab: React.FC = () => {
  const api = useAPIClient();
  const { t } = useCarboneTranslation();
  const [search, setSearch] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [editing, setEditing] = useState<TemplateRow | null>(null);

  const { data, loading, refresh } = useRequest<{ data: TemplateRow[] }>(
    () =>
      api
        .resource(COLLECTION.templates)
        .list({
          pageSize: 50,
          sort: ['-updatedAt'],
          ...(search ? { filter: { name: { $includes: search } } } : {}),
        })
        .then((r: any) => r.data),
    { refreshDeps: [search] },
  );

  const onDelete = async (row: TemplateRow) => {
    try {
      await api.resource(COLLECTION.templates).destroy({ filterByTk: row.id });
      message.success(t('Deleted'));
      refresh();
    } catch (err: any) {
      message.error(err?.message || t('Delete failed'));
    }
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setEditing(null);
            setUploadOpen(true);
          }}
        >
          {t('New template')}
        </Button>
        <Button icon={<ReloadOutlined />} onClick={refresh}>
          {t('Refresh')}
        </Button>
        <Input.Search
          placeholder={t('Search by name')}
          allowClear
          onSearch={setSearch}
          style={{ width: 280 }}
        />
      </Space>

      <Table<TemplateRow>
        rowKey="id"
        loading={loading}
        dataSource={data?.data || []}
        pagination={{ pageSize: 20 }}
        columns={[
          {
            title: t('Name'),
            dataIndex: 'name',
            render: (name, row) => (
              <div>
                <div>
                  <strong>{name}</strong>
                  {!row.enabled && (
                    <Tag color="default" style={{ marginLeft: 6 }}>
                      {t('disabled')}
                    </Tag>
                  )}
                </div>
                {row.description && <div style={{ color: '#888', fontSize: 12 }}>{row.description}</div>}
              </div>
            ),
          },
          {
            title: t('Category'),
            dataIndex: 'category',
            width: 140,
            render: (c) => c || <span style={{ color: '#aaa' }}>—</span>,
          },
          {
            title: t('Output'),
            dataIndex: 'defaultOutputFormat',
            width: 90,
            render: (f) => <Tag>{(f || 'pdf').toUpperCase()}</Tag>,
          },
          {
            title: t('File'),
            width: 160,
            render: (_, row) => (
              <span style={{ fontSize: 12, color: '#888' }}>
                {row.originalFileName}
                {row.fileSize ? ` · ${(row.fileSize / 1024).toFixed(1)} KB` : ''}
              </span>
            ),
          },
          {
            title: t('Carbone ID'),
            dataIndex: 'carboneTemplateId',
            width: 140,
            render: (v) =>
              v ? <code style={{ fontSize: 11 }}>{v.slice(0, 12)}…</code> : <span>—</span>,
          },
          {
            title: t('Updated'),
            dataIndex: 'updatedAt',
            width: 160,
            render: (v) => (v ? new Date(v).toLocaleString() : ''),
          },
          {
            title: t('Actions'),
            key: 'actions',
            width: 320,
            render: (_, row) => (
              <Space wrap>
                <Button
                  size="small"
                  onClick={() => {
                    setEditing(row);
                    setUploadOpen(true);
                  }}
                >
                  {t('New version')}
                </Button>
                <Button
                  size="small"
                  onClick={() => {
                    setEditing(row);
                    setVersionsOpen(true);
                  }}
                >
                  {t('Versions')}
                </Button>
                <Button
                  size="small"
                  onClick={() => {
                    window.open(`/api/${COLLECTION.templates}:download/${row.id}`, '_blank');
                  }}
                >
                  {t('Download')}
                </Button>
                <Popconfirm title={t('Delete this template?')} onConfirm={() => onDelete(row)}>
                  <Button size="small" danger>
                    {t('Delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <TemplateUploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSaved={refresh}
        template={editing}
      />
      <VersionHistory
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        template={editing}
        onChanged={refresh}
      />
    </div>
  );
};

export default TemplatesTab;
