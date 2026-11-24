// SPDX-License-Identifier: Apache-2.0

import { EyeOutlined, RedoOutlined, StopOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Popconfirm,
  Progress,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { RcloneTransferTaskRecord } from '../../shared/types';
import { useRcloneApi } from '../api';
import { useRcloneSession } from '../hooks/useRcloneSession';
import { useT } from '../locale';
import { formatBytes, formatDuration, getErrorMessage } from '../utils/format';
import { ConnectionHeader } from './ConnectionHeader';

function getElapsedSeconds(startedAt?: string | null, completedAt?: string | null): number | null {
  if (!startedAt || !completedAt) return null;
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(completedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return (endMs - startMs) / 1000;
}

function formatElapsed(elapsedSec: number | null): string {
  if (elapsedSec === null) return '—';
  if (elapsedSec < 1) {
    return `${Math.max(1, Math.round(elapsedSec * 1000))} ms`;
  }
  return formatDuration(elapsedSec);
}

function getEffectiveAvgSpeed(row: RcloneTransferTaskRecord, elapsedSec: number | null): number {
  if (typeof row.speed === 'number' && Number.isFinite(row.speed) && row.speed > 0) {
    return row.speed;
  }
  const bytes = Number(row.bytes ?? 0);
  if (bytes > 0 && elapsedSec !== null && elapsedSec > 0) {
    return bytes / Math.max(0.001, elapsedSec);
  }
  return 0;
}

function formatTimestamp(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export const RcloneTransfers: React.FC = () => {
  const t = useT();
  const api = useRcloneApi();
  const { enabledConnections, selectedConnectionId, setSelectedConnectionId, permissions } = useRcloneSession();

  const [tasks, setTasks] = useState<RcloneTransferTaskRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [rerunningId, setRerunningId] = useState<number | null>(null);
  const [detailTask, setDetailTask] = useState<RcloneTransferTaskRecord | null>(null);

  const loadJobs = useCallback(
    async (silent = false) => {
      if (!selectedConnectionId) {
        setTasks([]);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const list = await api.listJobs(selectedConnectionId);
        setTasks(list);
      } catch (err) {
        if (!silent) {
          message.error(getErrorMessage(err, t('Failed to load transfer jobs')));
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [api, selectedConnectionId, t],
  );

  useEffect(() => {
    loadJobs(false);
  }, [loadJobs]);

  const hasRunning = useMemo(
    () => tasks.some((item) => item.status === 'queued' || item.status === 'starting' || item.status === 'running'),
    [tasks],
  );

  useEffect(() => {
    if (!hasRunning || !selectedConnectionId) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadJobs(true);
      }
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [hasRunning, loadJobs, selectedConnectionId]);

  const handleStop = async (taskId: number) => {
    try {
      const res = await api.stopJob(taskId);
      if (res.stopped) {
        message.success(t('Transfer job stopped'));
      } else if (res.status === 'completed') {
        message.info(t('Transfer already completed'));
      } else if (res.status === 'failed') {
        message.warning(t('Transfer already failed'));
      } else if (res.status === 'unverified') {
        message.warning(t('Transfer outcome could not be verified'));
      } else {
        message.warning(t('Failed to stop transfer job'));
      }
      await loadJobs(false);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to stop transfer job')));
      await loadJobs(true);
    }
  };

  const handleRerun = async (row: RcloneTransferTaskRecord) => {
    setRerunningId(row.id);
    try {
      const nextTask = await api.triggerTransferWorkflow({
        connectionId: row.connectionId,
        operation: row.operation,
        srcFs: row.srcFs,
        srcRemote: row.srcRemote ?? '',
        dstFs: row.dstFs,
        dstRemote: row.dstRemote ?? '',
        createEmptySrcDirs: Boolean(row.createEmptySrcDirs),
        deleteEmptySrcDirs: Boolean(row.deleteEmptySrcDirs),
        dryRun: Boolean(row.dryRun),
        filterRules: row.filterRules ?? null,
      });
      message.success(`${t('Dispatched to NocoBase Workflow')} (#${nextTask.id})`);
      await loadJobs(false);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to trigger transfer workflow')));
    } finally {
      setRerunningId(null);
    }
  };

  const columns: ColumnsType<RcloneTransferTaskRecord> = [
    {
      title: t('ID'),
      dataIndex: 'id',
      key: 'id',
      width: 70,
      render: (id: number) => `#${id}`,
    },
    {
      title: t('Operation'),
      dataIndex: 'operation',
      key: 'operation',
      width: 150,
      render: (op: string, row: RcloneTransferTaskRecord) => (
        <Space size={4}>
          <Tag color="blue">{op}</Tag>
          {row.dryRun && <Tag color="gold">{t('Dry Run')}</Tag>}
        </Space>
      ),
    },
    {
      title: t('Source -> Destination'),
      key: 'paths',
      render: (_v: unknown, row: RcloneTransferTaskRecord) => {
        const src = row.srcRemote ? `${row.srcFs}/${row.srcRemote}` : row.srcFs;
        const dst = row.dstRemote ? `${row.dstFs}/${row.dstRemote}` : row.dstFs;
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text code>{src}</Typography.Text>
            <Typography.Text type="secondary">↳ {dst}</Typography.Text>
          </Space>
        );
      },
    },
    {
      title: t('Workflow'),
      key: 'workflow',
      width: 130,
      render: (_v: unknown, row: RcloneTransferTaskRecord) =>
        row.executionId ? <Tag color="purple">{`Exec #${row.executionId}`}</Tag> : <Tag>{row.triggerSource}</Tag>,
    },
    {
      title: t('Progress'),
      key: 'progress',
      width: 200,
      render: (_v: unknown, row: RcloneTransferTaskRecord) => (
        <div>
          <Progress
            percent={row.progress ?? 0}
            size="small"
            status={
              row.status === 'failed'
                ? 'exception'
                : row.status === 'completed'
                  ? 'success'
                  : row.status === 'running' || row.status === 'starting'
                    ? 'active'
                    : 'normal'
            }
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatBytes(row.bytes)} / {row.totalBytes ? formatBytes(row.totalBytes) : '—'}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: t('Speed / Duration'),
      key: 'speed',
      width: 165,
      render: (_v: unknown, row: RcloneTransferTaskRecord) => {
        if (row.status === 'running') {
          return (
            <Space direction="vertical" size={0}>
              <Typography.Text>{`${formatBytes(row.speed)}/s`}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {`${t('ETA')}: ${formatDuration(row.eta)}`}
              </Typography.Text>
            </Space>
          );
        }
        if (row.status === 'queued' || row.status === 'starting') {
          return <Typography.Text type="secondary">{t('Waiting for worker...')}</Typography.Text>;
        }
        const elapsedSec = getElapsedSeconds(row.startedAt, row.completedAt);
        const avgSpeed = getEffectiveAvgSpeed(row, elapsedSec);
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text>{avgSpeed > 0 ? `${formatBytes(avgSpeed)}/s` : '—'}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {`${t('Duration')}: ${formatElapsed(elapsedSec)}`}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: t('Status'),
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (status: string, row: RcloneTransferTaskRecord) => {
        const color =
          status === 'completed'
            ? 'success'
            : status === 'running' || status === 'starting' || status === 'queued'
              ? 'processing'
              : status === 'unverified'
                ? 'warning'
                : status === 'failed'
                  ? 'error'
                  : 'default';
        return (
          <Space size={4}>
            <Tag color={color}>{t(status)}</Tag>
            {row.errorText && (
              <Tooltip title={row.errorText}>
                <Typography.Text type="danger" style={{ cursor: 'help' }}>
                  [!]
                </Typography.Text>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 160,
      render: (_v: unknown, row: RcloneTransferTaskRecord) => (
        <Space size={4}>
          <Button
            size="small"
            icon={<EyeOutlined />}
            aria-label={`${t('Details')} #${row.id}`}
            onClick={() => setDetailTask(row)}
          >
            {t('Details')}
          </Button>
          {permissions.canTransfer &&
            (row.status === 'running' || row.status === 'starting' || row.status === 'queued') && (
              <Popconfirm title={t('Stop this running transfer?')} onConfirm={() => handleStop(row.id)}>
                <Button size="small" danger icon={<StopOutlined />}>
                  {t('Stop')}
                </Button>
              </Popconfirm>
            )}
          {permissions.canTransfer &&
            row.status !== 'running' &&
            row.status !== 'starting' &&
            row.status !== 'queued' &&
            row.status !== 'unverified' && (
              <Popconfirm title={t('Re-run this transfer workflow?')} onConfirm={() => handleRerun(row)}>
                <Button
                  size="small"
                  icon={<RedoOutlined />}
                  loading={rerunningId === row.id}
                  aria-label={`${t('Re-run')} #${row.id}`}
                >
                  {t('Re-run')}
                </Button>
              </Popconfirm>
            )}
        </Space>
      ),
    },
  ];

  const detailElapsed = detailTask ? getElapsedSeconds(detailTask.startedAt, detailTask.completedAt) : null;
  const detailAvgSpeed = detailTask ? getEffectiveAvgSpeed(detailTask, detailElapsed) : 0;

  return (
    <div role="region" aria-label={t('Rclone Transfers')}>
      <ConnectionHeader
        title={t('Transfers (Workflow Jobs)')}
        connections={enabledConnections}
        selectedConnectionId={selectedConnectionId}
        onSelectConnection={setSelectedConnectionId}
        onRefresh={() => loadJobs(false)}
        loading={loading}
      />

      <Card size="small">
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={tasks}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
        />
      </Card>

      <Drawer
        title={detailTask ? `${t('Transfer Details')} #${detailTask.id}` : t('Transfer Details')}
        width={560}
        open={Boolean(detailTask)}
        onClose={() => setDetailTask(null)}
        destroyOnClose
      >
        {detailTask && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {detailTask.errorText && (
              <Alert type="error" showIcon message={t('Transfer Error')} description={detailTask.errorText} />
            )}
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label={t('Status')}>
                <Tag
                  color={
                    detailTask.status === 'completed'
                      ? 'success'
                      : detailTask.status === 'failed'
                        ? 'error'
                        : detailTask.status === 'unverified'
                          ? 'warning'
                          : detailTask.status === 'running' ||
                              detailTask.status === 'starting' ||
                              detailTask.status === 'queued'
                            ? 'processing'
                            : 'default'
                  }
                >
                  {t(detailTask.status)}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('Operation')}>
                <Space size={4}>
                  <Tag color="blue">{detailTask.operation}</Tag>
                  {detailTask.dryRun && <Tag color="gold">{t('Dry Run')}</Tag>}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label={t('Source')}>
                <Typography.Text code>
                  {detailTask.srcRemote ? `${detailTask.srcFs}/${detailTask.srcRemote}` : detailTask.srcFs}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label={t('Destination')}>
                <Typography.Text code>
                  {detailTask.dstRemote ? `${detailTask.dstFs}/${detailTask.dstRemote}` : detailTask.dstFs}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label={t('Transferred')}>
                {`${formatBytes(detailTask.bytes)} / ${
                  detailTask.totalBytes ? formatBytes(detailTask.totalBytes) : '—'
                } (${detailTask.progress ?? 0}%)`}
              </Descriptions.Item>
              <Descriptions.Item label={t('Average Speed')}>
                {detailAvgSpeed > 0 ? `${formatBytes(detailAvgSpeed)}/s` : '—'}
              </Descriptions.Item>
              <Descriptions.Item label={t('Duration')}>{formatElapsed(detailElapsed)}</Descriptions.Item>
              <Descriptions.Item label={t('Workflow ID')}>
                {detailTask.workflowId ? String(detailTask.workflowId) : '—'}
              </Descriptions.Item>
              <Descriptions.Item label={t('Execution ID')}>
                {detailTask.executionId ? String(detailTask.executionId) : '—'}
              </Descriptions.Item>
              <Descriptions.Item label={t('Rclone Job ID')}>
                {detailTask.rcloneJobId ? String(detailTask.rcloneJobId) : '—'}
              </Descriptions.Item>
              <Descriptions.Item label={t('Started At')}>{formatTimestamp(detailTask.startedAt)}</Descriptions.Item>
              <Descriptions.Item label={t('Completed At')}>{formatTimestamp(detailTask.completedAt)}</Descriptions.Item>
            </Descriptions>
          </Space>
        )}
      </Drawer>
    </div>
  );
};

export default RcloneTransfers;
