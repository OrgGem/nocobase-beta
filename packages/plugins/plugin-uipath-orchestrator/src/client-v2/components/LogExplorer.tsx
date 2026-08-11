import React, { useState } from 'react';
import { Alert, Table, Tag, Space, Input, Select, Button, Drawer } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useCurrentInstance } from '../context/InstanceContext';
import { toUiPathArray, useUiPathRequest } from '../hooks/useUiPathRequest';
import { useT } from '../locale';
import { combineFilters, containsFilter, dateRangeFilter } from '../utils/odataFilters';
import { CorrelationTracePanel } from '../CorrelationTracePanel';

type UiPathLog = Record<string, unknown>;

const levelColors: Record<string, string> = {
  Error: 'red',
  Warn: 'orange',
  Info: 'blue',
  Trace: 'default',
  Fatal: 'magenta',
};

const LOG_LEVELS = ['Trace', 'Info', 'Warn', 'Error', 'Fatal'];

export const LogExplorer: React.FC = () => {
  const t = useT();
  const { dateRange, processFilter, queueFilter, instanceId, folderId, folderKey, folderPath, folderReady } =
    useCurrentInstance();
  const [level, setLevel] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [jobKey, setJobKey] = useState('');
  const [queueItem, setQueueItem] = useState('');
  const [tracingLog, setTracingLog] = useState<UiPathLog | null>(null);

  const { data, meta, loading, error, refresh } = useUiPathRequest('uipathRobotLogs', 'search', {
    level,
    jobKey: jobKey || undefined,
    message: search || undefined,
    queueItem: queueItem || queueFilter || undefined,
    filter: combineFilters([containsFilter('ProcessName', processFilter), dateRangeFilter('TimeStamp', dateRange)]),
    top: 100,
    count: true,
    orderby: 'TimeStamp desc',
  });
  const logs = toUiPathArray<UiPathLog>(data);
  const jobKeys =
    meta && typeof meta === 'object' && Array.isArray((meta as { jobKeys?: unknown }).jobKeys)
      ? (meta as { jobKeys: string[] }).jobKeys
      : [];

  const columns = [
    {
      title: t('Level'),
      dataIndex: 'Level',
      width: 80,
      render: (value: string) => <Tag color={levelColors[value] || 'default'}>{value}</Tag>,
    },
    {
      title: t('Time'),
      dataIndex: 'TimeStamp',
      width: 180,
      render: (value: string) => (value ? new Date(value).toLocaleString() : '-'),
    },
    { title: t('Process'), dataIndex: 'ProcessName', width: 180, ellipsis: true },
    { title: t('Robot'), dataIndex: 'RobotName', width: 140, ellipsis: true },
    { title: t('Machine'), dataIndex: 'MachineName', width: 140, ellipsis: true },
    { title: t('Message'), dataIndex: 'Message', ellipsis: true },
    { title: t('Job Key'), dataIndex: 'JobKey', width: 120, ellipsis: true },
    {
      title: t('Actions'),
      width: 120,
      render: (_: unknown, record: UiPathLog) => (
        <Button size="small" onClick={() => setTracingLog(record)}>
          {t('Execution Trace')}
        </Button>
      ),
    },
  ];

  return (
    <div>
      {error ? (
        <Alert type="error" showIcon message={t('Failed')} description={error.message} style={{ marginBottom: 16 }} />
      ) : null}
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder={t('Log level')}
          allowClear
          style={{ width: 120 }}
          value={level}
          onChange={setLevel}
          options={LOG_LEVELS.map((value) => ({ label: value, value }))}
        />
        <Input
          placeholder={t('Job Key')}
          style={{ width: 180 }}
          value={jobKey}
          onChange={(event) => setJobKey(event.target.value)}
          allowClear
        />
        <Input.Search
          placeholder={t('Queue item ID/key/reference')}
          style={{ width: 240 }}
          value={queueItem}
          onChange={(event) => setQueueItem(event.target.value)}
          onSearch={setQueueItem}
          allowClear
        />
        <Input.Search placeholder={t('Search message')} style={{ width: 250 }} onSearch={setSearch} allowClear />
        <Button onClick={() => refresh()} icon={<ReloadOutlined />}>
          {t('Refresh')}
        </Button>
      </Space>
      {jobKeys.length ? (
        <Space style={{ marginBottom: 16 }} wrap>
          <span>{t('Resolved job keys')}:</span>
          {jobKeys.map((key) => (
            <Tag key={key}>{key}</Tag>
          ))}
        </Space>
      ) : null}
      <Table
        dataSource={logs}
        columns={columns}
        rowKey={(record) => String(record.Id)}
        loading={loading}
        size="small"
        pagination={{ pageSize: 100 }}
        scroll={{ x: 1200 }}
      />
      <Drawer title={t('Execution Trace')} open={Boolean(tracingLog)} onClose={() => setTracingLog(null)} width={800}>
        {tracingLog ? (
          <CorrelationTracePanel
            target={{ kind: 'log', log: tracingLog }}
            instanceId={instanceId}
            folderId={folderId}
            folderKey={folderKey}
            folderPath={folderPath}
            folderReady={folderReady}
          />
        ) : null}
      </Drawer>
    </div>
  );
};
