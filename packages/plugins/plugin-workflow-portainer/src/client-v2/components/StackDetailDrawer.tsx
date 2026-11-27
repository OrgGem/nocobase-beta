/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CodeOutlined,
  FileTextOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PORTAINER_RESOURCE } from '../../shared/constants';
import type {
  PortainerContainerSummary,
  PortainerDeploymentRecord,
  PortainerEndpointSummary,
  PortainerInstanceSummary,
  PortainerMaskedEnvItem,
  PortainerStackOverview,
  PortainerStackSummary,
} from '../../shared/types';
import { useT } from '../locale';

export function formatBytes(bytes?: number | null): string {
  const num = Number(bytes ?? 0);
  if (!Number.isFinite(num) || num <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let val = num;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val >= 100 || idx === 0 ? Math.round(val) : val.toFixed(1)} ${units[idx]}`;
}

function formatUnixTime(unixSeconds?: number): string {
  if (!unixSeconds || !Number.isFinite(unixSeconds) || unixSeconds <= 0) {
    return '-';
  }
  return new Date(unixSeconds * 1000).toLocaleString();
}

function renderStackStatusTag(status: number, t: ReturnType<typeof useT>) {
  if (status === 3) {
    return <Tag color="processing">{t('Deploying')}</Tag>;
  }
  if (status === 4) {
    return <Tag color="error">{t('Error')}</Tag>;
  }
  return <Tag color={status === 1 ? 'success' : 'default'}>{status === 1 ? t('Active') : t('Inactive')}</Tag>;
}

export interface StackDetailDrawerProps {
  open: boolean;
  instance: PortainerInstanceSummary | null;
  stack: PortainerStackSummary | null;
  endpoints: PortainerEndpointSummary[];
  onClose: () => void;
  onStackChanged?: () => void;
}

export function StackDetailDrawer({
  open,
  instance,
  stack,
  endpoints,
  onClose,
  onStackChanged,
}: StackDetailDrawerProps) {
  const t = useT();
  const api = useApp().apiClient;

  const [overview, setOverview] = useState<PortainerStackOverview | null>(null);
  const [initialLoading, setInitialLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [controlling, setControlling] = useState<'start' | 'stop' | null>(null);

  const [logContainer, setLogContainer] = useState<PortainerContainerSummary | null>(null);
  const [logTail, setLogTail] = useState<number>(100);
  const [logText, setLogText] = useState<string>('');
  const [loadingLogs, setLoadingLogs] = useState(false);

  const inFlightRef = useRef(false);

  const fetchOverview = useCallback(
    async (options?: { silent?: boolean; includeFile?: boolean }) => {
      if (!instance || !stack || inFlightRef.current) {
        return;
      }
      inFlightRef.current = true;
      if (options?.silent) {
        setRefreshing(true);
      } else {
        setInitialLoading(true);
      }
      try {
        const res = await api.request<{ data?: PortainerStackOverview }>({
          url: `${PORTAINER_RESOURCE}:getStackOverview`,
          method: 'get',
          params: {
            instanceId: instance.id,
            stackId: stack.id,
            includeStats: 'true',
            includeFile: options?.includeFile === false ? 'false' : 'true',
          },
        });
        const data = res?.data?.data;
        if (data) {
          setOverview((prev) => ({
            ...data,
            stackFileContent: options?.includeFile === false && prev ? prev.stackFileContent : data.stackFileContent,
          }));
          setErrorMsg(null);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : t('Failed to load Stack details from Portainer');
        setErrorMsg(msg);
      } finally {
        inFlightRef.current = false;
        setInitialLoading(false);
        setRefreshing(false);
      }
    },
    [api, instance, stack, t],
  );

  useEffect(() => {
    if (open && instance && stack) {
      setOverview(null);
      setErrorMsg(null);
      fetchOverview({ silent: false, includeFile: true });
    } else {
      setAutoRefresh(false);
      setLogContainer(null);
    }
  }, [fetchOverview, instance, open, stack]);

  useEffect(() => {
    if (!open || !autoRefresh || !instance || !stack) {
      return;
    }
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      fetchOverview({ silent: true, includeFile: false });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, fetchOverview, instance, open, stack]);

  const fetchContainerLogs = useCallback(
    async (target: PortainerContainerSummary, tailLines: number) => {
      if (!instance || !stack) {
        return;
      }
      const epId = overview?.detail.endpointId ?? stack.endpointId;
      setLoadingLogs(true);
      try {
        const res = await api.request<{ data?: { logs?: string } }>({
          url: `${PORTAINER_RESOURCE}:getContainerLogs`,
          method: 'get',
          params: {
            instanceId: instance.id,
            endpointId: epId,
            containerId: target.id,
            tail: tailLines,
          },
        });
        setLogText(String(res?.data?.data?.logs ?? ''));
      } catch {
        message.error(t('Failed to fetch container logs'));
      } finally {
        setLoadingLogs(false);
      }
    },
    [api, instance, overview?.detail.endpointId, stack, t],
  );

  const openLogsModal = (container: PortainerContainerSummary) => {
    setLogContainer(container);
    setLogText('');
    fetchContainerLogs(container, logTail);
  };

  const handleControlStack = async (operation: 'start' | 'stop') => {
    if (!instance || !stack) {
      return;
    }
    const epId = overview?.detail.endpointId ?? stack.endpointId;
    setControlling(operation);
    try {
      await api.request({
        url: `${PORTAINER_RESOURCE}:controlStack`,
        method: 'post',
        data: {
          instanceId: instance.id,
          endpointId: epId,
          stackId: stack.id,
          operation,
        },
      });
      message.success(operation === 'start' ? t('Stack started') : t('Stack stopped'));
      await fetchOverview({ silent: true, includeFile: false });
      onStackChanged?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('Failed to control Stack');
      message.error(msg);
    } finally {
      setControlling(null);
    }
  };

  const detail = overview?.detail;
  const summary = overview?.summary;
  const endpointId = detail?.endpointId ?? stack?.endpointId;
  const endpointName = endpointId ? endpoints.find((ep) => ep.id === endpointId)?.name ?? `#${endpointId}` : '-';
  const currentStatus = detail?.status ?? stack?.status ?? 1;

  const containerColumns: ColumnsType<PortainerContainerSummary> = [
    {
      title: t('Container / Service'),
      key: 'name',
      width: 230,
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          <Space size="small" wrap>
            <Typography.Text strong>{record.name || record.id}</Typography.Text>
            {record.service ? <Tag color="geekblue">{record.service}</Tag> : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.image}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('State & Uptime'),
      key: 'state',
      width: 150,
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          <Tag
            color={record.healthy ? 'success' : record.state === 'exited' ? 'default' : 'error'}
            icon={record.healthy ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
          >
            {record.state}
          </Tag>
          {record.status ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {record.status}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t('Ports & IP'),
      key: 'network',
      width: 190,
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          {record.ports && record.ports.length > 0 ? (
            record.ports.map((p) => (
              <Typography.Text key={p} code style={{ fontSize: 12 }}>
                {p}
              </Typography.Text>
            ))
          ) : (
            <Typography.Text type="secondary">-</Typography.Text>
          )}
          {record.ipAddresses && record.ipAddresses.length > 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              IP: {record.ipAddresses.join(', ')}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t('CPU'),
      key: 'cpu',
      width: 130,
      render: (_, record) =>
        record.stats ? (
          <Space direction="vertical" size={0} style={{ width: '100%' }}>
            <Typography.Text strong>{record.stats.cpuPercent.toFixed(2)}%</Typography.Text>
            <Progress
              percent={Math.min(100, Number(record.stats.cpuPercent.toFixed(1)))}
              size="small"
              showInfo={false}
              aria-label={`${t('CPU')} ${record.name}`}
            />
          </Space>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: t('Memory'),
      key: 'memory',
      width: 175,
      render: (_, record) =>
        record.stats ? (
          <Space direction="vertical" size={0} style={{ width: '100%' }}>
            <Typography.Text strong>
              {formatBytes(record.stats.memUsageBytes)}{' '}
              <Typography.Text type="secondary" style={{ fontWeight: 400, fontSize: 12 }}>
                / {formatBytes(record.stats.memLimitBytes)}
              </Typography.Text>
            </Typography.Text>
            <Progress
              percent={Math.min(100, Number(record.stats.memPercent.toFixed(1)))}
              size="small"
              showInfo={false}
              aria-label={`${t('Memory')} ${record.name}`}
            />
          </Space>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: t('Network / PIDs'),
      key: 'io',
      width: 165,
      render: (_, record) =>
        record.stats ? (
          <Space direction="vertical" size={0} style={{ fontSize: 12 }}>
            <Typography.Text style={{ fontSize: 12 }}>
              ↓ {formatBytes(record.stats.netRxBytes)} / ↑ {formatBytes(record.stats.netTxBytes)}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              PIDs: {record.stats.pids}
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 96,
      fixed: 'right',
      render: (_, record) => (
        <Button
          size="small"
          htmlType="button"
          icon={<FileTextOutlined />}
          aria-label={`${t('Logs')} ${record.name || record.id}`}
          onClick={() => openLogsModal(record)}
        >
          {t('Logs')}
        </Button>
      ),
    },
  ];

  const envColumns: ColumnsType<PortainerMaskedEnvItem> = [
    {
      title: t('Name'),
      dataIndex: 'name',
      key: 'name',
      width: 240,
      render: (name: string, row) => (
        <Space size="small">
          <Typography.Text code>{name}</Typography.Text>
          {row.sensitive ? <Tag color="warning">{t('Secret')}</Tag> : null}
        </Space>
      ),
    },
    {
      title: t('Value'),
      dataIndex: 'value',
      key: 'value',
      render: (val: string, row) =>
        row.sensitive ? (
          <Typography.Text type="secondary">{val}</Typography.Text>
        ) : (
          <Typography.Text style={{ wordBreak: 'break-all' }}>{val || '-'}</Typography.Text>
        ),
    },
  ];

  const deploymentColumns: ColumnsType<PortainerDeploymentRecord> = [
    {
      title: t('Time'),
      dataIndex: 'time',
      key: 'time',
      width: 190,
      render: (time?: number) => formatUnixTime(time),
    },
    {
      title: t('Status'),
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (st: number) => renderStackStatusTag(st, t),
    },
    {
      title: t('Message'),
      dataIndex: 'message',
      key: 'message',
      render: (msg?: string) => msg || '-',
    },
  ];

  return (
    <>
      <Drawer
        open={open}
        width={920}
        onClose={onClose}
        title={
          <Space size="small" wrap>
            <span>
              {t('Stack Detail')} — {stack?.name ?? ''}
            </span>
            {stack ? renderStackStatusTag(currentStatus, t) : null}
            {stack ? (
              <Tag color={detail?.isGitStack ?? stack.isGitStack ? 'processing' : 'purple'}>
                {detail?.isGitStack ?? stack.isGitStack ? t('Git Stack') : t('Compose')}
              </Tag>
            ) : null}
          </Space>
        }
        extra={
          <Space size="small" wrap>
            <Space size={6}>
              <Switch
                size="small"
                checked={autoRefresh}
                aria-label={t('Auto-refresh live metrics (5s)')}
                onChange={(checked) => setAutoRefresh(checked)}
              />
              <Typography.Text style={{ fontSize: 12 }}>{t('Auto-refresh (5s)')}</Typography.Text>
            </Space>
            {currentStatus === 2 ? (
              <Button
                size="small"
                type="primary"
                htmlType="button"
                icon={<PlayCircleOutlined />}
                loading={controlling === 'start'}
                onClick={() => {
                  handleControlStack('start');
                }}
              >
                {t('Start Stack')}
              </Button>
            ) : (
              <Popconfirm title={t('Stop this Stack on Portainer?')} onConfirm={() => handleControlStack('stop')}>
                <Button
                  size="small"
                  danger
                  htmlType="button"
                  icon={<PauseCircleOutlined />}
                  loading={controlling === 'stop'}
                >
                  {t('Stop Stack')}
                </Button>
              </Popconfirm>
            )}
            <Button
              size="small"
              htmlType="button"
              icon={<ReloadOutlined />}
              loading={refreshing || initialLoading}
              onClick={() => {
                fetchOverview({ silent: Boolean(overview), includeFile: true });
              }}
            >
              {t('Refresh')}
            </Button>
          </Space>
        }
      >
        {errorMsg ? <Alert type="error" showIcon style={{ marginBottom: 16 }} message={errorMsg} /> : null}

        {initialLoading && !overview ? (
          <Flex justify="center" align="center" style={{ minHeight: 260 }}>
            <Spin size="large" />
          </Flex>
        ) : overview ? (
          <>
            <Flex gap="small" wrap="wrap" style={{ marginBottom: 16 }}>
              <Card size="small" style={{ flex: '1 1 180px' }}>
                <Statistic
                  title={t('Containers Health')}
                  value={summary?.runningCount ?? 0}
                  suffix={`/ ${summary?.totalCount ?? 0}`}
                  valueStyle={{
                    color: (summary?.totalCount ?? 0) === 0 ? undefined : summary?.healthy ? '#389e0d' : '#cf1322',
                  }}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {endpointName} (#{endpointId})
                </Typography.Text>
              </Card>

              <Card size="small" style={{ flex: '1 1 190px' }}>
                <Statistic title={t('Live CPU Usage')} value={summary?.totalCpuPercent ?? 0} precision={2} suffix="%" />
                <Progress
                  percent={Math.min(100, Number((summary?.totalCpuPercent ?? 0).toFixed(1)))}
                  size="small"
                  showInfo={false}
                  aria-label={t('Live CPU Usage')}
                />
              </Card>

              <Card size="small" style={{ flex: '1 1 220px' }}>
                <Statistic
                  title={t('Live Memory Usage')}
                  value={formatBytes(summary?.totalMemUsageBytes ?? 0)}
                  suffix={
                    summary?.memLimitBytes ? (
                      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                        / {formatBytes(summary.memLimitBytes)} ({summary.totalMemPercent.toFixed(1)}%)
                      </Typography.Text>
                    ) : null
                  }
                />
                <Progress
                  percent={Math.min(100, Number((summary?.totalMemPercent ?? 0).toFixed(1)))}
                  size="small"
                  showInfo={false}
                  aria-label={t('Live Memory Usage')}
                />
              </Card>

              <Card size="small" style={{ flex: '1 1 200px' }}>
                <Statistic
                  title={t('Network I/O (RX / TX)')}
                  value={`↓ ${formatBytes(summary?.totalNetRxBytes ?? 0)}`}
                  valueStyle={{ fontSize: 16 }}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  ↑ {formatBytes(summary?.totalNetTxBytes ?? 0)}
                </Typography.Text>
              </Card>
            </Flex>

            <Tabs
              defaultActiveKey="containers"
              items={[
                {
                  key: 'containers',
                  label: `${t('Containers & Live Metrics')} (${overview.containers.length})`,
                  children: (
                    <div
                      tabIndex={0}
                      role="region"
                      aria-label={t('Stack containers and live metrics')}
                      style={{ overflowX: 'auto', maxInlineSize: '100%' }}
                    >
                      <Table<PortainerContainerSummary>
                        rowKey="id"
                        size="small"
                        pagination={false}
                        scroll={{ x: 1120 }}
                        dataSource={overview.containers}
                        columns={containerColumns}
                        locale={{ emptyText: <Empty description={t('No containers found for this Stack')} /> }}
                      />
                    </div>
                  ),
                },
                {
                  key: 'metadata',
                  label: t('Stack Metadata'),
                  children: (
                    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                      <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }}>
                        <Descriptions.Item label={t('Stack ID')}>{detail?.id}</Descriptions.Item>
                        <Descriptions.Item label={t('Stack Name')}>{detail?.name}</Descriptions.Item>
                        <Descriptions.Item label={t('Endpoint')}>
                          {endpointName} (#{endpointId})
                        </Descriptions.Item>
                        <Descriptions.Item label={t('Entry point')}>
                          <Typography.Text code>{detail?.entryPoint || 'docker-compose.yml'}</Typography.Text>
                        </Descriptions.Item>
                        <Descriptions.Item label={t('Created at')}>
                          {formatUnixTime(detail?.createdAt)}
                          {detail?.createdBy ? ` (${detail.createdBy})` : ''}
                        </Descriptions.Item>
                        <Descriptions.Item label={t('Last updated')}>
                          {formatUnixTime(detail?.updatedAt)}
                          {detail?.updatedBy ? ` (${detail.updatedBy})` : ''}
                        </Descriptions.Item>
                        {detail?.isGitStack ? (
                          <>
                            <Descriptions.Item label={t('Connected Git repository')} span={2}>
                              <Typography.Text code>{detail.gitRepoUrl || '-'}</Typography.Text>
                            </Descriptions.Item>
                            <Descriptions.Item label={t('Git reference')}>
                              <Typography.Text code>{detail.gitReference || '-'}</Typography.Text>
                            </Descriptions.Item>
                            <Descriptions.Item label={t('Git commit / config')}>
                              {detail.gitCommitHash ? (
                                <Typography.Text code>{detail.gitCommitHash.slice(0, 12)}</Typography.Text>
                              ) : (
                                '-'
                              )}
                              {detail.gitConfigFilePath ? ` (${detail.gitConfigFilePath})` : ''}
                            </Descriptions.Item>
                          </>
                        ) : null}
                        {detail?.projectPath ? (
                          <Descriptions.Item label={t('Project path')} span={2}>
                            <Typography.Text code>{detail.projectPath}</Typography.Text>
                          </Descriptions.Item>
                        ) : null}
                      </Descriptions>

                      {detail?.deployments && detail.deployments.length > 0 ? (
                        <Card size="small" title={t('Deployment History')}>
                          <Table<PortainerDeploymentRecord>
                            rowKey={(row, idx) => `${row.time ?? 0}-${idx ?? 0}`}
                            size="small"
                            pagination={{ pageSize: 5 }}
                            dataSource={[...detail.deployments].reverse()}
                            columns={deploymentColumns}
                          />
                        </Card>
                      ) : null}
                    </Space>
                  ),
                },
                {
                  key: 'env',
                  label: `${t('Env Vars')} (${detail?.env.length ?? 0})`,
                  children: (
                    <Table<PortainerMaskedEnvItem>
                      rowKey="name"
                      size="small"
                      pagination={{ pageSize: 15 }}
                      dataSource={detail?.env ?? []}
                      columns={envColumns}
                      locale={{ emptyText: <Empty description={t('No environment variables configured')} /> }}
                    />
                  ),
                },
                {
                  key: 'compose',
                  label: (
                    <span>
                      <CodeOutlined style={{ marginInlineEnd: 6 }} />
                      {t('Compose File')}
                    </span>
                  ),
                  children: overview.stackFileContent ? (
                    <pre
                      tabIndex={0}
                      role="region"
                      aria-label={t('Compose File')}
                      style={{
                        margin: 0,
                        padding: 12,
                        maxHeight: 480,
                        overflow: 'auto',
                        borderRadius: 6,
                        background: '#141414',
                        color: '#e6f4ff',
                        fontSize: 12,
                        lineHeight: 1.55,
                      }}
                    >
                      {overview.stackFileContent}
                    </pre>
                  ) : (
                    <Empty description={t('Compose file content is unavailable')} />
                  ),
                },
              ]}
            />
          </>
        ) : null}
      </Drawer>

      <Modal
        open={Boolean(logContainer)}
        width={840}
        onCancel={() => setLogContainer(null)}
        footer={
          <Flex justify="space-between" align="center">
            <Space size="small">
              <Typography.Text type="secondary">{t('Tail lines')}:</Typography.Text>
              <Select<number>
                size="small"
                style={{ width: 110 }}
                value={logTail}
                aria-label={t('Tail lines')}
                options={[
                  { value: 50, label: '50' },
                  { value: 100, label: '100' },
                  { value: 300, label: '300' },
                ]}
                onChange={(nextTail) => {
                  setLogTail(nextTail);
                  if (logContainer) {
                    fetchContainerLogs(logContainer, nextTail);
                  }
                }}
              />
            </Space>
            <Space>
              <Button
                htmlType="button"
                icon={<ReloadOutlined />}
                loading={loadingLogs}
                onClick={() => {
                  if (logContainer) {
                    fetchContainerLogs(logContainer, logTail);
                  }
                }}
              >
                {t('Refresh')}
              </Button>
              <Button type="primary" htmlType="button" onClick={() => setLogContainer(null)}>
                {t('Close')}
              </Button>
            </Space>
          </Flex>
        }
        title={logContainer ? `${t('Container Logs')} — ${logContainer.name || logContainer.id}` : t('Container Logs')}
      >
        <Spin spinning={loadingLogs}>
          <pre
            tabIndex={0}
            role="region"
            aria-label={t('Container Logs')}
            style={{
              margin: 0,
              padding: 12,
              minHeight: 240,
              maxHeight: 460,
              overflow: 'auto',
              borderRadius: 6,
              background: '#141414',
              color: '#d9f7be',
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {logText || t('No log output')}
          </pre>
        </Spin>
      </Modal>
    </>
  );
}
