import React, { useState, useCallback, useEffect } from 'react';
import { Button, Space, Card, Typography, Tag, Empty, message, Spin, Descriptions, List, Badge, theme } from 'antd';
import {
  CloudDownloadOutlined,
  SyncOutlined,
  BranchesOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  FileAddOutlined,
  EditOutlined,
  DeleteOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useGitManager } from '../context/GitManagerContext';
import { useT } from '../locale';

const { Text } = Typography;
const { useToken } = theme;

const FILE_STATUS_MAP: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
  not_added: { color: 'green', icon: <FileAddOutlined />, label: 'New' },
  modified: { color: 'blue', icon: <EditOutlined />, label: 'Modified' },
  deleted: { color: 'red', icon: <DeleteOutlined />, label: 'Deleted' },
  renamed: { color: 'orange', icon: <EditOutlined />, label: 'Renamed' },
  conflicted: { color: 'red', icon: <WarningOutlined />, label: 'Conflict' },
  created: { color: 'green', icon: <FileAddOutlined />, label: 'Created' },
};

export const GitOperations: React.FC = () => {
  const t = useT();
  const { token } = useToken();
  const api = useApp().apiClient;
  const { selectedRepo, refreshRepos } = useGitManager();
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [statusData, setStatusData] = useState<any>(null);
  const [lastResult, setLastResult] = useState<{ action: string; success: boolean; message: string } | null>(null);

  const loadStatus = useCallback(async () => {
    if (!selectedRepo || selectedRepo.status !== 'connected') {
      setStatusData(null);
      return;
    }
    setActionLoading('status');
    try {
      const { data } = await api.request({
        url: 'gitManager:status',
        method: 'post',
        params: { repositoryId: selectedRepo.id },
      });
      const responseData = data?.data?.data || data?.data;
      setStatusData(responseData);
    } catch (error) {
      console.warn('Failed to load git status:', error);
      setStatusData(null);
    } finally {
      setActionLoading(null);
    }
  }, [api, selectedRepo]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const execAction = useCallback(
    async (action: string) => {
      if (!selectedRepo) return;
      setActionLoading(action);
      setLastResult(null);
      try {
        const { data } = await api.request({
          url: `gitManager:${action}`,
          method: 'post',
          params: { repositoryId: selectedRepo.id },
        });
        setLastResult({ action, success: true, message: t('{{action}} completed successfully', { action }) });
        message.success(t('{{action}} completed', { action }));
        const responseData = data?.data?.data || data?.data;
        if (action === 'status') setStatusData(responseData);
        if (action === 'fetch' || action === 'pull') await loadStatus();
        await refreshRepos();
      } catch (err: any) {
        const msg = err?.response?.data?.errors?.[0]?.message || t('{{action}} failed', { action });
        setLastResult({ action, success: false, message: msg });
        message.error(msg);
      } finally {
        setActionLoading(null);
      }
    },
    [api, selectedRepo, refreshRepos, loadStatus],
  );

  if (!selectedRepo) {
    return <Empty description={t('No repository selected')} />;
  }
  if (selectedRepo.status !== 'connected') {
    return <Empty description={t('Repository not cloned yet')} />;
  }

  const allChangedFiles = statusData
    ? [
        ...statusData.not_added?.map((f: string) => ({ file: f, status: 'not_added' })) || [],
        ...statusData.modified?.map((f: string) => ({ file: f, status: 'modified' })) || [],
        ...statusData.deleted?.map((f: string) => ({ file: f, status: 'deleted' })) || [],
        ...statusData.renamed?.map((f: any) => ({ file: typeof f === 'string' ? f : f.to, status: 'renamed' })) || [],
        ...statusData.conflicted?.map((f: string) => ({ file: f, status: 'conflicted' })) || [],
        ...statusData.created?.map((f: string) => ({ file: f, status: 'created' })) || [],
      ]
    : [];

  return (
    <div>
      <Space size="middle" wrap style={{ marginBottom: 24 }}>
        <Button
          size="large"
          icon={<SyncOutlined />}
          loading={actionLoading === 'fetch'}
          onClick={() => execAction('fetch')}
        >
          {t('Fetch')}
        </Button>
        <Button
          size="large"
          type="primary"
          icon={<CloudDownloadOutlined />}
          loading={actionLoading === 'pull'}
          onClick={() => execAction('pull')}
        >
          {t('Pull')}
        </Button>
        <Button
          size="large"
          icon={<BranchesOutlined />}
          loading={actionLoading === 'status'}
          onClick={loadStatus}
        >
          {t('Status')}
        </Button>
      </Space>

      {lastResult && (
        <Card
          size="small"
          style={{
            marginBottom: 16,
            borderColor: lastResult.success ? token.colorSuccessBorder : token.colorErrorBorder,
          }}
        >
          <Space>
            {lastResult.success ? (
              <CheckCircleOutlined style={{ color: token.colorSuccess }} />
            ) : (
              <WarningOutlined style={{ color: token.colorError }} />
            )}
            <Text strong>{lastResult.action}</Text>
            <Text>{lastResult.message}</Text>
          </Space>
        </Card>
      )}

      {statusData && (
        <Card title={t('Working Directory Status')} size="small">
          <Descriptions column={3} size="small" style={{ marginBottom: 16 }}>
            <Descriptions.Item label="Branch">
              <Tag icon={<BranchesOutlined />} color="blue">{statusData.current}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Tracking">
              <Text>{statusData.tracking || 'N/A'}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="Changes">
              <Space>
                {statusData.ahead > 0 && <Badge count={`${statusData.ahead} ahead`} style={{ backgroundColor: token.colorPrimary }} />}
                {statusData.behind > 0 && <Badge count={`${statusData.behind} behind`} style={{ backgroundColor: token.colorWarning }} />}
                {statusData.ahead === 0 && statusData.behind === 0 && (
                  <Tag color="green" icon={<CheckCircleOutlined />}>Up to date</Tag>
                )}
              </Space>
            </Descriptions.Item>
          </Descriptions>

          {allChangedFiles.length > 0 ? (
            <>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>
                {allChangedFiles.length} changed file(s)
              </Text>
              <List
                size="small"
                dataSource={allChangedFiles}
                renderItem={(item: any) => {
                  const info = FILE_STATUS_MAP[item.status] || { color: 'default', icon: <QuestionCircleOutlined />, label: item.status };
                  return (
                    <List.Item style={{ padding: '4px 0' }}>
                      <Space>
                        <Tag color={info.color} style={{ minWidth: 80, textAlign: 'center' }}>
                          {info.icon} {info.label}
                        </Tag>
                        <Text code style={{ fontSize: 13 }}>{item.file}</Text>
                      </Space>
                    </List.Item>
                  );
                }}
              />
            </>
          ) : (
            <Text type="secondary">Working directory clean</Text>
          )}
        </Card>
      )}
    </div>
  );
};
