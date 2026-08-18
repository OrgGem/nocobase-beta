import React, { useState, useEffect, useCallback } from 'react';
import {
  Card,
  Table,
  Tag,
  Button,
  Space,
  Select,
  message,
  Modal,
  Typography,
  Alert,
  Switch,
  Popconfirm,
  Row,
  Col,
  Tooltip,
} from 'antd';
import {
  ReloadOutlined,
  ScanOutlined,
  BranchesOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  MinusCircleOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useT } from './utils';

const { Text } = Typography;

interface DiscoveredQueue {
  name: string;
  label: string;
  description: string;
  type: 'event-queue' | 'redis-list' | 'db-poll';
  pending: number | null;
  workerProcessName?: string;
}

interface RegisteredMapping {
  id: number;
  queueName: string;
  label: string;
  stackId: number | null;
  enabled: boolean;
  type: string;
}

interface StackInfo {
  id: number;
  name: string;
  adapter: string;
}

export function QueueAssignment() {
  const t = useT();
  const api = useApp().apiClient;
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredQueue[]>([]);
  const [mappings, setMappings] = useState<RegisteredMapping[]>([]);
  const [unmapped, setUnmapped] = useState<DiscoveredQueue[]>([]);
  const [stacks, setStacks] = useState<StackInfo[]>([]);

  const fetchStacks = useCallback(async () => {
    try {
      const res = await api.request({ url: '/orchestratorStacks:list', params: { pageSize: 50 } });
      const data = res.data?.data || [];
      setStacks(data);
    } catch {
      // Collection not available
    }
  }, [api]);

  const fetchMappings = useCallback(async () => {
    try {
      const res = await api.request({ url: '/workerQueueMappings:list', params: { pageSize: 200 } });
      const data = res.data?.data || [];
      setMappings(data);
    } catch {
      // Collection may not exist yet
    }
  }, [api]);

  const scanQueues = useCallback(async () => {
    setScanning(true);
    try {
      const res = await api.request({ url: '/workerQueueMappings:scanQueues' });
      const data = res.data?.data || res.data;
      setDiscovered(data.discovered || []);
      setMappings(data.registered || []);
      setUnmapped(data.unmapped || []);
    } catch (err: any) {
      message.error(t('Scan failed: {error}').replace('{error}', err.message));
    } finally {
      setScanning(false);
    }
  }, [api, t]);

  const handleAutoMap = async () => {
    setLoading(true);
    try {
      const res = await api.request({
        url: '/workerQueueMappings:autoMap',
        method: 'POST',
        data: {},
      });
      const { created } = res.data?.data || res.data;
      message.success(t('Auto-mapped {count} queue(s)').replace('{count}', String(created.length)));
      await scanQueues();
    } catch (err: any) {
      message.error(t('Auto-map failed: {error}').replace('{error}', err.message));
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateMapping = async (id: number, values: Partial<RegisteredMapping>) => {
    setLoading(true);
    try {
      await api.request({
        url: '/workerQueueMappings:update',
        method: 'PUT',
        params: { filterByTk: id },
        data: values,
      });
      await fetchMappings();
    } catch (err: any) {
      message.error(t('Update failed: {error}').replace('{error}', err.message));
    } finally {
      setLoading(false);
    }
  };

  const handleCreateMapping = async (queue: DiscoveredQueue) => {
    setLoading(true);
    try {
      await api.request({
        url: '/workerQueueMappings:create',
        method: 'POST',
        data: {
          queueName: queue.name,
          label: queue.label,
          description: queue.description,
          type: queue.type,
          stackId: null,
          enabled: true,
        },
      });
      message.success(t('Mapping created for "{name}"').replace('{name}', queue.name));
      await scanQueues();
    } catch (err: any) {
      message.error(t('Create failed: {error}').replace('{error}', err.message));
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteMapping = async (id: number) => {
    setLoading(true);
    try {
      await api.request({
        url: '/workerQueueMappings:destroy',
        method: 'POST',
        params: { filterByTk: id },
      });
      message.success(t('Mapping deleted'));
      await scanQueues();
    } catch (err: any) {
      message.error(t('Delete failed: {error}').replace('{error}', err.message));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    scanQueues();
    fetchStacks();
  }, [scanQueues, fetchStacks]);

  const stackOptions = stacks.map((s) => ({
    value: s.id,
    label: s.name,
  }));

  const mappingMap = new Map(mappings.map((m) => [m.queueName, m]));

  const allRows = discovered.map((q) => {
    const mapping = mappingMap.get(q.name);
    return {
      key: q.name,
      ...q,
      mappingId: mapping?.id ?? null,
      registered: Boolean(mapping),
      stackId: mapping?.stackId ?? null,
      enabled: mapping?.enabled ?? true,
    };
  });

  const columns = [
    {
      title: t('Queue Name'),
      dataIndex: 'name',
      render: (name: string, record: any) => (
        <Space>
          {record.type === 'event-queue' ? (
            <BranchesOutlined style={{ color: '#1890ff' }} />
          ) : record.type === 'db-poll' ? (
            <ClockCircleOutlined style={{ color: '#722ed1' }} />
          ) : (
            <MinusCircleOutlined style={{ color: '#52c41a' }} />
          )}
          <Space direction="vertical" size={0}>
            <Text code>{name}</Text>
            {record.workerProcessName && record.workerProcessName !== name ? (
              <Text type="secondary">{record.workerProcessName}</Text>
            ) : null}
          </Space>
        </Space>
      ),
    },
    {
      title: t('Label'),
      dataIndex: 'label',
      render: (label: string) => <Text>{label}</Text>,
    },
    {
      title: t('Type'),
      dataIndex: 'type',
      width: 110,
      render: (type: string) => (
        <Tag color={type === 'event-queue' ? 'blue' : type === 'db-poll' ? 'purple' : 'green'}>
          {type === 'event-queue' ? t('EventQueue') : type === 'db-poll' ? t('DB Poll') : t('Redis List')}
        </Tag>
      ),
    },
    {
      title: t('Pending'),
      dataIndex: 'pending',
      width: 80,
      render: (val: number | null) => (val !== null ? <Text>{val}</Text> : <Text type="secondary">-</Text>),
    },
    {
      title: t('Assigned Stack'),
      dataIndex: 'stackId',
      width: 160,
      render: (stackId: number | null, record: any) => {
        if (!record.registered) {
          return <Text type="secondary">—</Text>;
        }
        return (
          <Select
            style={{ width: 150 }}
            size="small"
            allowClear
            placeholder={t('All (default)')}
            value={stackId}
            options={stackOptions}
            onChange={(value) => handleUpdateMapping(record.mappingId, { stackId: value ?? null })}
          />
        );
      },
    },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      width: 80,
      render: (enabled: boolean, record: any) => {
        if (!record.registered) {
          return <Text type="secondary">—</Text>;
        }
        return (
          <Switch
            size="small"
            checked={enabled}
            onChange={(checked) => handleUpdateMapping(record.mappingId, { enabled: checked })}
          />
        );
      },
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 200,
      render: (_: any, record: any) => {
        if (!record.registered) {
          return (
            <Button
              size="small"
              type="link"
              icon={<CheckCircleOutlined style={{ color: '#52c41a' }} />}
              onClick={() => handleCreateMapping(record)}
            >
              {t('Register')}
            </Button>
          );
        }
        return (
          <Popconfirm title={t('Delete this mapping?')} onConfirm={() => handleDeleteMapping(record.mappingId)}>
            <Button size="small" type="link" danger>
              {t('Unregister')}
            </Button>
          </Popconfirm>
        );
      },
    },
  ];

  return (
    <div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Row justify="space-between" align="middle">
          <Col>
            <Space>
              <Text strong>{t('Queue Assignment')}</Text>
              <Text type="secondary">
                {t('Fallback mapping for legacy stacks without explicit Processes / queues.')}
              </Text>
            </Space>
          </Col>
          <Col>
            <Space>
              <Button icon={<ScanOutlined />} onClick={scanQueues} loading={scanning}>
                {t('Scan Queues')}
              </Button>
              {unmapped.length > 0 && (
                <Button onClick={handleAutoMap} loading={loading}>
                  {t('Auto-map ({count})').replace('{count}', String(unmapped.length))}
                </Button>
              )}
              <Button
                icon={<ReloadOutlined />}
                onClick={() => {
                  scanQueues();
                  fetchStacks();
                }}
              >
                {t('Refresh')}
              </Button>
            </Space>
          </Col>
        </Row>
      </Card>

      {unmapped.length > 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={t(
            '{count} queue(s) discovered but not yet registered. Click "Register" on each row or use "Auto-map" to create mappings.',
          ).replace('{count}', String(unmapped.length))}
        />
      )}

      <Table
        dataSource={allRows}
        columns={columns}
        rowKey="key"
        size="small"
        pagination={false}
        locale={{ emptyText: t('No queues discovered. Click "Scan Queues" to detect registered queues.') }}
      />
    </div>
  );
}
