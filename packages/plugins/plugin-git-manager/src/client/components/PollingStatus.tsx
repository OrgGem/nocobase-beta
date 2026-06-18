import React, { useCallback, useEffect, useState } from 'react';
import { Card, Button, Space, Tag, Typography, Table, message, Tooltip, Empty, theme } from 'antd';
import { ReloadOutlined, ThunderboltOutlined, ClockCircleOutlined, RobotOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useGitManager } from '../context/GitManagerContext';
import { useT } from '../locale';

const { Text } = Typography;
const { useToken } = theme;

interface PollerStatus {
  running: boolean;
  polling: boolean;
  lastTickAt: string | null;
  lastError: string | null;
  intervalSec: number;
}

export const PollingStatus: React.FC = () => {
  const t = useT();
  const { token } = useToken();
  const api = useApp().apiClient;
  const { repos, refreshRepos } = useGitManager();
  const [status, setStatus] = useState<PollerStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [pollingId, setPollingId] = useState<number | 'all' | null>(null);
  const [flows, setFlows] = useState<any[]>([]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data }, flowsRes] = await Promise.all([
        api.request({ url: 'gitManager:pollerStatus' }),
        api.request({
          url: 'gitReviewFlows:list',
          params: {
            pageSize: 100,
            filter: {
              enabled: true,
              triggerMode: { $in: ['onMergeRequestCreated', 'both'] },
            },
          },
        }),
      ]);
      setStatus(data?.data || null);
      setFlows(flowsRes?.data?.data || []);
      await refreshRepos();
    } finally {
      setLoading(false);
    }
  }, [api, refreshRepos]);

  useEffect(() => {
    reload();
  }, [reload]);

  const pollAll = async () => {
    setPollingId('all');
    try {
      const { data } = await api.request({ url: 'gitManager:pollNow', method: 'post' });
      const result = data?.data || {};
      message.success(
        t('Polled {{scanned}} MRs, triggered {{triggered}} reviews', {
          scanned: result.scanned ?? 0,
          triggered: result.triggered ?? 0,
        }),
      );
      reload();
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || err?.message || t('Failed'));
    } finally {
      setPollingId(null);
    }
  };

  const pollOne = async (repoId: number) => {
    setPollingId(repoId);
    try {
      const { data } = await api.request({
        url: 'gitManager:pollNow',
        method: 'post',
        data: { repositoryId: repoId },
      });
      const result = data?.data || {};
      message.success(
        t('Polled {{scanned}} MRs, triggered {{triggered}} reviews', {
          scanned: result.scanned ?? 0,
          triggered: result.triggered ?? 0,
        }),
      );
      reload();
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || err?.message || t('Failed'));
    } finally {
      setPollingId(null);
    }
  };

  const autoRepos = repos.filter((r: any) => r.autoReview);

  return (
    <div>
      <Card
        size="small"
        style={{ marginBottom: 16 }}
        title={
          <Space>
            <ClockCircleOutlined />
            {t('Polling Status')}
          </Space>
        }
        extra={
          <Space>
            <Button
              size="small"
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={pollAll}
              loading={pollingId === 'all'}
              disabled={autoRepos.length === 0}
            >
              {t('Poll Now (All)')}
            </Button>
            <Button size="small" icon={<ReloadOutlined />} onClick={reload} loading={loading}>
              {t('Refresh')}
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Space>
            <Text type="secondary">{t('Background poller')}:</Text>
            <Tag color={status?.running ? 'green' : 'default'}>
              {status?.running ? t('Running') : t('Stopped')}
            </Tag>
            {status?.polling && <Tag color="blue">{t('Polling now…')}</Tag>}
          </Space>
          <Space>
            <Text type="secondary">{t('Interval')}:</Text>
            <Text>{status?.intervalSec ? `${status.intervalSec}s` : '—'}</Text>
          </Space>
          <Space>
            <Text type="secondary">{t('Last tick')}:</Text>
            <Text>{status?.lastTickAt ? new Date(status.lastTickAt).toLocaleString() : t('Never')}</Text>
          </Space>
          {status?.lastError && (
            <Space>
              <Text type="secondary">{t('Last error')}:</Text>
              <Text type="danger" style={{ fontSize: 12 }}>{status.lastError}</Text>
            </Space>
          )}
        </Space>
      </Card>

      <Card
        size="small"
        title={
          <Space>
            <RobotOutlined />
            {t('Auto-Review Repositories')}
          </Space>
        }
        extra={
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('Toggle Auto Review on the Repositories tab to enable polling')}
          </Text>
        }
      >
        {autoRepos.length === 0 ? (
          <Empty description={t('No repositories have Auto Review enabled')} />
        ) : (
          <Table
            size="small"
            rowKey="id"
            dataSource={autoRepos}
            pagination={false}
            columns={[
              { title: t('Repository Name'), dataIndex: 'name' },
              {
                title: t('Primary Auto Flow'),
                dataIndex: 'autoReviewFlowId',
                width: 220,
                render: (flowId: number | null, record: any) => {
                  const flow = flows.find((item) => Number(item.id) === Number(flowId));
                  const fallback = flows.find((item) => item.repositoryId === record.id || item.repositoryId == null);
                  if (flow) return <Tag color="blue">{flow.name}</Tag>;
                  if (fallback) return <Tag color="default">{t('Fallback')}: {fallback.name}</Tag>;
                  return <Tag color="red">{t('No matching flow available')}</Tag>;
                },
              },
              {
                title: t('Last Polled At'),
                dataIndex: 'lastPolledAt',
                width: 200,
                render: (v: string | null) => (v ? new Date(v).toLocaleString() : t('Never')),
              },
              {
                title: '',
                key: 'actions',
                width: 120,
                render: (_: any, record: any) => (
                  <Tooltip title={t('Poll this repository now')}>
                    <Button
                      size="small"
                      icon={<ThunderboltOutlined />}
                      onClick={() => pollOne(record.id)}
                      loading={pollingId === record.id}
                    >
                      {t('Poll Now')}
                    </Button>
                  </Tooltip>
                ),
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
};
