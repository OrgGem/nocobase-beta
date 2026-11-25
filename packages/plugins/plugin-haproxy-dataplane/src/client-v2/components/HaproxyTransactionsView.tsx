// SPDX-License-Identifier: Apache-2.0

import {
  CheckCircleOutlined,
  CheckOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  PlusOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { Button, Card, Empty, message, Popconfirm, Space, Switch, Table, Tag, Typography } from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import type { HaproxyReload, HaproxyTransaction } from '../../shared/types';
import { useHaproxyApi } from '../api';
import { useHaproxySession } from '../hooks/useHaproxySession';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/format';
import { NodeToolbar } from './NodeToolbar';

export const HaproxyTransactionsView: React.FC<{ fixedConnectionId?: number }> = ({ fixedConnectionId }) => {
  const t = useT();
  const api = useHaproxyApi();
  const { permissions, connections, selectedConnectionId, setSelectedConnectionId, bootstrapping } =
    useHaproxySession(fixedConnectionId);

  const canConfig = Boolean(permissions?.canConfig);
  const [loading, setLoading] = useState(false);
  const [transactions, setTransactions] = useState<HaproxyTransaction[]>([]);
  const [reloads, setReloads] = useState<HaproxyReload[]>([]);
  const [forceReload, setForceReload] = useState(false);

  const loadData = useCallback(async () => {
    if (!selectedConnectionId) return;
    setLoading(true);
    try {
      const [txs, rlds] = await Promise.all([
        api.listTransactions(selectedConnectionId),
        api.listReloads(selectedConnectionId),
      ]);
      setTransactions(txs);
      setReloads([...rlds].reverse());
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [api, selectedConnectionId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleStart = useCallback(async () => {
    if (!selectedConnectionId) return;
    try {
      const tx = await api.startTransaction(selectedConnectionId);
      message.success(
        t('Transaction {{id}} started (base version {{version}})', {
          id: tx.id,
          version: tx._version ?? '?',
        }),
      );
      await loadData();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  }, [api, loadData, selectedConnectionId, t]);

  const handleCommit = useCallback(
    async (txId: string) => {
      if (!selectedConnectionId) return;
      try {
        await api.commitTransaction(selectedConnectionId, txId, forceReload);
        message.success(t('Transaction {{id}} committed', { id: txId }));
        await loadData();
      } catch (err) {
        message.error(getErrorMessage(err));
      }
    },
    [api, forceReload, loadData, selectedConnectionId, t],
  );

  const handleDelete = useCallback(
    async (txId: string) => {
      if (!selectedConnectionId) return;
      try {
        await api.deleteTransaction(selectedConnectionId, txId);
        message.success(t('Transaction {{id}} discarded', { id: txId }));
        await loadData();
      } catch (err) {
        message.error(getErrorMessage(err));
      }
    },
    [api, loadData, selectedConnectionId, t],
  );

  if (!bootstrapping && connections.length === 0) {
    return (
      <Card>
        <Empty description={t('No enabled HAProxy Data Plane connections')} />
      </Card>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <NodeToolbar
        connections={connections}
        selectedConnectionId={selectedConnectionId}
        onSelectConnection={setSelectedConnectionId}
        fixedConnectionId={fixedConnectionId}
        loading={loading}
        onRefresh={loadData}
      />

      <Card
        size="small"
        title={t('Open Transactions')}
        extra={
          canConfig ? (
            <Space>
              <Switch
                checked={forceReload}
                onChange={setForceReload}
                aria-label={t('Force immediate reload (skip reload-delay)')}
              />
              <Typography.Text>{t('Force immediate reload (skip reload-delay)')}</Typography.Text>
              <Button htmlType="button" type="primary" icon={<PlusOutlined aria-hidden="true" />} onClick={handleStart}>
                {t('Start Transaction')}
              </Button>
            </Space>
          ) : null
        }
      >
        <Table<HaproxyTransaction>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={transactions}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          columns={[
            {
              title: t('Transaction ID'),
              dataIndex: 'id',
              key: 'id',
              render: (id: string) => <Typography.Text code>{id}</Typography.Text>,
            },
            {
              title: t('Config Version'),
              dataIndex: '_version',
              key: '_version',
              render: (ver?: number) => (ver != null ? `v${ver}` : '—'),
            },
            {
              title: t('Status'),
              dataIndex: 'status',
              key: 'status',
              render: (status: string) => (
                <Tag color={status === 'in_progress' ? 'processing' : status === 'failed' ? 'error' : 'default'}>
                  {status}
                </Tag>
              ),
            },
            ...(canConfig
              ? [
                  {
                    title: t('Actions'),
                    key: 'actions',
                    render: (_v: unknown, row: HaproxyTransaction) => (
                      <Space size={6}>
                        {row.status === 'in_progress' && (
                          <Button
                            htmlType="button"
                            size="small"
                            type="primary"
                            icon={<CheckOutlined aria-hidden="true" />}
                            aria-label={`${t('Commit Transaction')} ${row.id}`}
                            onClick={() => handleCommit(row.id)}
                          >
                            {t('Commit Transaction')}
                          </Button>
                        )}
                        <Popconfirm title={t('Discard this transaction?')} onConfirm={() => handleDelete(row.id)}>
                          <Button
                            htmlType="button"
                            size="small"
                            danger
                            icon={<DeleteOutlined aria-hidden="true" />}
                            aria-label={`${t('Discard Transaction')} ${row.id}`}
                          >
                            {t('Discard Transaction')}
                          </Button>
                        </Popconfirm>
                      </Space>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Card>

      <Card size="small" title={t('Reload History')}>
        <Table<HaproxyReload>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={reloads}
          pagination={{ pageSize: 15, hideOnSinglePage: true }}
          columns={[
            {
              title: t('Reload ID'),
              dataIndex: 'id',
              key: 'id',
              render: (id: string) => <Typography.Text code>{id}</Typography.Text>,
            },
            {
              title: t('Status'),
              dataIndex: 'status',
              key: 'status',
              render: (status: string) => {
                if (status === 'succeeded') {
                  return (
                    <Tag icon={<CheckCircleOutlined aria-hidden="true" />} color="success">
                      succeeded
                    </Tag>
                  );
                }
                if (status === 'failed') {
                  return (
                    <Tag icon={<CloseCircleOutlined aria-hidden="true" />} color="error">
                      failed
                    </Tag>
                  );
                }
                return (
                  <Tag icon={<SyncOutlined spin aria-hidden="true" />} color="processing">
                    {status}
                  </Tag>
                );
              },
            },
            {
              title: t('Timestamp'),
              dataIndex: 'reload_timestamp',
              key: 'reload_timestamp',
              render: (ts?: number) => (ts ? new Date(ts * 1000).toLocaleString() : '—'),
            },
            {
              title: t('Daemon Output / Error'),
              dataIndex: 'response',
              key: 'response',
              render: (resp?: string) =>
                resp ? (
                  <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                    {resp}
                  </Typography.Paragraph>
                ) : (
                  '—'
                ),
            },
          ]}
        />
      </Card>
    </Space>
  );
};

export default HaproxyTransactionsView;
