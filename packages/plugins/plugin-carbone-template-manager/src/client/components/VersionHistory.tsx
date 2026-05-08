import React, { useState } from 'react';
import { Button, Drawer, List, Popconfirm, Space, Tag, message } from 'antd';
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
  changeNote?: string;
  placeholderSchema?: PlaceholderSchemaView;
  createdAt: string;
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

  const onRollback = async (id: number) => {
    try {
      await api.resource(COLLECTION.versions).rollback({ filterByTk: id });
      message.success(t('Rolled back successfully'));
      refresh();
      onChanged();
      onClose();
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
      width={620}
      title={template ? t('Versions of "{{name}}"', { name: template.name }) : ''}
      destroyOnClose
    >
      <List
        loading={loading}
        dataSource={data?.data || []}
        renderItem={(v) => {
          const isCurrent = template?.currentVersionId === v.id;
          return (
            <List.Item
              actions={
                [
                  <Button
                    key="dl"
                    size="small"
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
                      <Button size="small">{t('Roll back')}</Button>
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
                      <Button size="small" danger>
                        {t('Delete')}
                      </Button>
                    </Popconfirm>
                  ) : null,
                ].filter(Boolean) as React.ReactNode[]
              }
            >
              <List.Item.Meta
                title={
                  <Space>
                    <strong>v{v.versionNumber}</strong>
                    <span style={{ color: '#888' }}>{new Date(v.createdAt).toLocaleString()}</span>
                  </Space>
                }
                description={
                  <div>
                    <div>{v.changeNote || <em style={{ color: '#aaa' }}>{t('(no note)')}</em>}</div>
                    <div style={{ fontSize: 12, color: '#aaa' }}>
                      <code>{v.carboneTemplateId.slice(0, 12)}…</code> · MD5 <code>{v.fileMd5?.slice(0, 8)}…</code>
                    </div>
                    {v.placeholderSchema && (
                      <details style={{ marginTop: 6 }}>
                        <summary style={{ cursor: 'pointer', color: '#1677ff' }}>{t('Show schema')}</summary>
                        <div style={{ marginTop: 6 }}>
                          <PlaceholderTree schema={v.placeholderSchema} />
                        </div>
                      </details>
                    )}
                  </div>
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
