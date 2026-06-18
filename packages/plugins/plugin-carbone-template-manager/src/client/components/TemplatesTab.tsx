import React, { useState } from 'react';
import { Button, Input, Popconfirm, Space, Switch, Table, Tag, Tooltip, Typography, message } from 'antd';
import {
  DeleteOutlined,
  FileSearchOutlined,
  HistoryOutlined,
  PlusOutlined,
  ReloadOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useRequest } from 'ahooks';
import { useCarboneTranslation } from '../locale';
import { COLLECTION } from '../../shared/constants';
import { TemplateUploadModal } from './TemplateUploadModal';
import { VersionHistory } from './VersionHistory';
import { TemplatePreviewModal } from './TemplatePreviewModal';

interface CurrentVersion {
  id: number;
  versionNumber: number;
  description?: string | null;
  changeNote?: string | null;
  originalFileName?: string;
  fileSize?: number;
  fileMd5?: string;
  carboneTemplateId?: string;
  createdAt?: string;
}

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
  currentVersion?: CurrentVersion | null;
  originalFileName?: string;
  fileSize?: number;
  updatedAt: string;
}

export const TemplatesTab: React.FC = () => {
  const api = useApp().apiClient;
  const { t } = useCarboneTranslation();
  const [search, setSearch] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [editing, setEditing] = useState<TemplateRow | null>(null);
  const [previewData, setPreviewData] = useState<{ url: string; filename: string } | null>(null);

  const { data, loading, refresh } = useRequest<{ data: TemplateRow[] }>(
    () =>
      api
        .resource(COLLECTION.templates)
        .list({
          pageSize: 50,
          sort: ['-updatedAt'],
          appends: ['currentVersion'],
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

  const onToggleEnabled = async (row: TemplateRow, enabled: boolean) => {
    try {
      await api.resource(COLLECTION.templates).update({ filterByTk: row.id, values: { enabled } });
      refresh();
    } catch (err: any) {
      message.error(err?.message || t('Save failed'));
    }
  };

  const onPreview = (row: TemplateRow) => {
    const filename = currentFileName(row) || `${row.name}.${row.defaultOutputFormat || 'pdf'}`;
    setPreviewData({ url: `/api/${COLLECTION.templates}:download/${row.id}`, filename });
  };

  const openNewVersion = (row: TemplateRow) => {
    setEditing({ ...row, description: currentDescription(row) || undefined });
    setUploadOpen(true);
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
        <Input.Search placeholder={t('Search by name')} allowClear onSearch={setSearch} style={{ width: 280 }} />
      </Space>

      <div style={{ width: '100%', maxWidth: '100%', overflowX: 'auto' }}>
        <Table<TemplateRow>
          rowKey="id"
          loading={loading}
          dataSource={data?.data || []}
          pagination={{ pageSize: 20 }}
          scroll={{ x: 1500 }}
          columns={[
            {
              title: t('Template'),
              dataIndex: 'name',
              width: 360,
              render: (name, row) => {
                const description = currentDescription(row);
                return (
                  <div>
                    <Space size={6} wrap>
                      <Typography.Text strong>{name}</Typography.Text>
                      {row.category && <Tag>{row.category}</Tag>}
                    </Space>
                    <Typography.Paragraph
                      type="secondary"
                      style={{ marginBottom: 0, maxWidth: 420 }}
                      ellipsis={{ rows: 2, tooltip: description }}
                    >
                      {description || t('N/A')}
                    </Typography.Paragraph>
                  </div>
                );
              },
            },
            {
              title: t('Current'),
              width: 200,
              render: (_, row) => {
                const current = row.currentVersion;
                if (!current) return <Typography.Text type="secondary">-</Typography.Text>;
                return (
                  <Space direction="vertical" size={2}>
                    <Tag color="green" style={{ width: 'fit-content', marginRight: 0 }}>
                      v{current.versionNumber}
                    </Tag>
                    {current.createdAt && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {formatDate(current.createdAt)}
                      </Typography.Text>
                    )}
                    {current.changeNote && (
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 12, maxWidth: 180 }}
                        ellipsis={{ tooltip: current.changeNote }}
                      >
                        {current.changeNote}
                      </Typography.Text>
                    )}
                  </Space>
                );
              },
            },
            {
              title: t('Enabled'),
              dataIndex: 'enabled',
              width: 90,
              render: (enabled, row) => (
                <Switch size="small" checked={enabled} onChange={(v) => onToggleEnabled(row, v)} />
              ),
            },
            {
              title: t('Output'),
              dataIndex: 'defaultOutputFormat',
              width: 90,
              render: (f) => <Tag>{(f || 'pdf').toUpperCase()}</Tag>,
            },
            {
              title: t('File'),
              width: 220,
              render: (_, row) => {
                const filename = currentFileName(row);
                const fileSize = currentFileSize(row);
                const md5 = row.currentVersion?.fileMd5;
                return (
                  <Space direction="vertical" size={2}>
                    <Typography.Text style={{ fontSize: 12 }} ellipsis={{ tooltip: filename }}>
                      {filename || '-'}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {fileSize ? formatSize(fileSize) : ''}
                      {md5 ? ` - MD5 ${md5.slice(0, 8)}...` : ''}
                    </Typography.Text>
                  </Space>
                );
              },
            },
            {
              title: t('Carbone ID'),
              width: 140,
              render: (_, row) => {
                const value = row.currentVersion?.carboneTemplateId || row.carboneTemplateId;
                return value ? <code style={{ fontSize: 11 }}>{value.slice(0, 12)}...</code> : <span>-</span>;
              },
            },
            {
              title: t('Updated'),
              dataIndex: 'updatedAt',
              width: 150,
              render: (v) => (v ? formatDate(v) : ''),
            },
            {
              title: t('Actions'),
              key: 'actions',
              width: 260,
              render: (_, row) => (
                <Space wrap>
                  <Tooltip title={t('Preview')}>
                    <Button size="small" icon={<FileSearchOutlined />} onClick={() => onPreview(row)} />
                  </Tooltip>
                  <Button size="small" icon={<UploadOutlined />} onClick={() => openNewVersion(row)}>
                    {t('New version')}
                  </Button>
                  <Button
                    size="small"
                    icon={<HistoryOutlined />}
                    onClick={() => {
                      setEditing(row);
                      setVersionsOpen(true);
                    }}
                  >
                    {t('Versions')}
                  </Button>
                  <Popconfirm title={t('Delete this template?')} onConfirm={() => onDelete(row)}>
                    <Button size="small" icon={<DeleteOutlined />} danger>
                      {t('Delete')}
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </div>

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
      <TemplatePreviewModal
        open={!!previewData}
        onClose={() => setPreviewData(null)}
        url={previewData?.url || ''}
        filename={previewData?.filename || ''}
      />
    </div>
  );
};

function currentDescription(row: TemplateRow) {
  return row.currentVersion?.description ?? row.description;
}

function currentFileName(row: TemplateRow) {
  return row.currentVersion?.originalFileName || row.originalFileName;
}

function currentFileSize(row: TemplateRow) {
  return row.currentVersion?.fileSize || row.fileSize;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function formatSize(value: number) {
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export default TemplatesTab;
