import React, { useEffect, useMemo, useState } from 'react';
import { Button, Drawer, List, Popconfirm, Space, Tag, Typography, message } from 'antd';
import { DeleteOutlined, FileSearchOutlined, RollbackOutlined } from '@ant-design/icons';
import { useAPIClient, useRequest } from '@nocobase/client';
import { useCarboneTranslation } from '../locale';
import { COLLECTION } from '../../shared/constants';
import { PlaceholderTree, PlaceholderSchemaView } from './PlaceholderTree';
import { TemplatePreviewModal } from './TemplatePreviewModal';

interface VersionRow {
  id: number;
  versionNumber: number;
  carboneTemplateId: string;
  fileMd5: string;
  originalFileName: string;
  description?: string | null;
  changeNote?: string | null;
  placeholderSchema?: PlaceholderSchemaView;
  createdAt: string;
  fileSize?: number;
  fileBackupId?: number | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  template: { id: number; name: string; currentVersionId?: number | null } | null;
  onChanged: () => void;
}

export const VersionHistory: React.FC<Props> = ({ open, onClose, template, onChanged }) => {
  const api = useAPIClient();
  const { t } = useCarboneTranslation();
  const [previewData, setPreviewData] = useState<{ url: string; filename: string } | null>(null);
  const [currentVersionId, setCurrentVersionId] = useState<number | null>(template?.currentVersionId ?? null);

  useEffect(() => {
    setCurrentVersionId(template?.currentVersionId ?? null);
  }, [template?.currentVersionId, template?.id, open]);

  const { data, loading, refresh } = useRequest<{ data: VersionRow[] }>(
    () =>
      template
        ? api
            .resource(COLLECTION.versions)
            .list({
              filter: { templateId: template.id },
              sort: ['-versionNumber'],
              pageSize: 50,
            })
            .then((r: any) => r.data)
        : Promise.resolve({ data: [] }),
    { ready: !!template && open, refreshDeps: [template?.id, open] },
  );

  const currentVersion = useMemo(
    () => (data?.data || []).find((item) => item.id === currentVersionId),
    [currentVersionId, data?.data],
  );

  const onRollback = async (id: number) => {
    try {
      await api.resource(COLLECTION.versions).rollback({ filterByTk: id });
      setCurrentVersionId(id);
      message.success(t('Rolled back successfully'));
      refresh();
      onChanged();
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || err?.message || t('Rollback failed'));
    }
  };

  const onDelete = async (id: number) => {
    try {
      await api.resource(COLLECTION.versions).destroy({ filterByTk: id });
      message.success(t('Version deleted successfully'));
      refresh();
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || err?.message || t('Delete failed'));
    }
  };

  const onPreview = (versionId: number, originalFileName: string) => {
    if (!template) return;
    const url = `/api/${COLLECTION.templates}:download/${template.id}?versionId=${versionId}`;
    setPreviewData({ url, filename: originalFileName });
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={760}
      title={template ? t('Versions of "{{name}}"', { name: template.name }) : ''}
      destroyOnClose
    >
      {currentVersion && (
        <div
          style={{
            marginBottom: 16,
            padding: 12,
            border: '1px solid #d9d9d9',
            borderRadius: 6,
            background: '#fafafa',
          }}
        >
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Space wrap>
              <Tag color="green">{t('Current')}</Tag>
              <Typography.Text strong>v{currentVersion.versionNumber}</Typography.Text>
              <Typography.Text type="secondary">{formatDate(currentVersion.createdAt)}</Typography.Text>
            </Space>
            <Typography.Paragraph style={{ marginBottom: 0 }}>
              {currentVersion.description || <Typography.Text type="secondary">{t('(no note)')}</Typography.Text>}
            </Typography.Paragraph>
            {currentVersion.changeNote && (
              <Typography.Text type="secondary">
                {t('Change note')}: {currentVersion.changeNote}
              </Typography.Text>
            )}
          </Space>
        </div>
      )}

      <List
        loading={loading}
        dataSource={data?.data || []}
        renderItem={(v: VersionRow) => {
          const isCurrent = currentVersionId === v.id;
          return (
            <List.Item
              actions={
                [
                  <Button
                    key="dl"
                    size="small"
                    icon={<FileSearchOutlined />}
                    onClick={() => onPreview(v.id, v.originalFileName || `template-v${v.versionNumber}`)}
                  >
                    {t('Preview')}
                  </Button>,
                  isCurrent ? (
                    <Tag key="current" color="green">
                      {t('Current')}
                    </Tag>
                  ) : (
                    <Popconfirm
                      key="rb"
                      title={t('Roll back to v{{n}}?', { n: v.versionNumber })}
                      okText={t('Yes')}
                      cancelText={t('No')}
                      onConfirm={() => onRollback(v.id)}
                    >
                      <Button size="small" icon={<RollbackOutlined />}>
                        {t('Roll back')}
                      </Button>
                    </Popconfirm>
                  ),
                  !isCurrent ? (
                    <Popconfirm
                      key="del"
                      title={t('Delete version v{{n}}?', { n: v.versionNumber })}
                      okText={t('Yes')}
                      cancelText={t('No')}
                      onConfirm={() => onDelete(v.id)}
                    >
                      <Button size="small" icon={<DeleteOutlined />} danger>
                        {t('Delete')}
                      </Button>
                    </Popconfirm>
                  ) : null,
                ].filter(Boolean) as React.ReactNode[]
              }
            >
              <List.Item.Meta
                title={
                  <Space wrap>
                    <Typography.Text strong>v{v.versionNumber}</Typography.Text>
                    <Typography.Text type="secondary">{formatDate(v.createdAt)}</Typography.Text>
                    {isCurrent && <Tag color="green">{t('Current')}</Tag>}
                  </Space>
                }
                description={
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <Typography.Paragraph style={{ marginBottom: 0 }}>
                      {v.description || <Typography.Text type="secondary">{t('(no note)')}</Typography.Text>}
                    </Typography.Paragraph>
                    {v.changeNote && (
                      <Typography.Text type="secondary">
                        {t('Change note')}: {v.changeNote}
                      </Typography.Text>
                    )}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {v.originalFileName}
                      {v.fileSize ? ` - ${formatSize(v.fileSize)}` : ''} - MD5 <code>{v.fileMd5?.slice(0, 8)}...</code>{' '}
                      - <code>{v.carboneTemplateId.slice(0, 12)}...</code>
                    </Typography.Text>
                    {v.placeholderSchema && (
                      <details style={{ marginTop: 6 }}>
                        <summary style={{ cursor: 'pointer', color: '#1677ff' }}>{t('Show schema')}</summary>
                        <div style={{ marginTop: 6 }}>
                          <PlaceholderTree schema={v.placeholderSchema} />
                        </div>
                      </details>
                    )}
                  </Space>
                }
              />
            </List.Item>
          );
        }}
      />
      <TemplatePreviewModal
        open={!!previewData}
        onClose={() => setPreviewData(null)}
        url={previewData?.url || ''}
        filename={previewData?.filename || ''}
      />
    </Drawer>
  );
};

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function formatSize(value: number) {
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
