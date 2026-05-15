/**
 * Log Explorer — robot logs with level/time/process/jobKey filters
 */

import React, { useState } from 'react';
import { Table, Tag, Space, Input, Select, Button } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useUiPathRequest } from '../hooks/useUiPathRequest';
import { useT } from '../locale';

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
  const [level, setLevel] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [jobKey, setJobKey] = useState('');
  const [queueItem, setQueueItem] = useState('');

  const { data, meta, loading, refresh } = useUiPathRequest('uipathRobotLogs', 'search', {
    level,
    jobKey: jobKey || undefined,
    message: search || undefined,
    queueItem: queueItem || undefined,
    top: 100,
    count: true,
    orderby: 'TimeStamp desc',
  });

  const columns = [
    {
      title: t('Level'),
      dataIndex: 'Level',
      width: 80,
      render: (l: string) => <Tag color={levelColors[l] || 'default'}>{l}</Tag>,
    },
    {
      title: t('Time'),
      dataIndex: 'TimeStamp',
      width: 180,
      render: (v: string) => (v ? new Date(v).toLocaleString() : '-'),
    },
    { title: t('Process'), dataIndex: 'ProcessName', width: 180, ellipsis: true },
    { title: t('Robot'), dataIndex: 'RobotName', width: 140, ellipsis: true },
    { title: t('Machine'), dataIndex: 'MachineName', width: 140, ellipsis: true },
    { title: t('Message'), dataIndex: 'Message', ellipsis: true },
    { title: t('Job Key'), dataIndex: 'JobKey', width: 120, ellipsis: true },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder={t('Log level')}
          allowClear
          style={{ width: 120 }}
          value={level}
          onChange={setLevel}
          options={LOG_LEVELS.map((l) => ({ label: l, value: l }))}
        />
        <Input
          placeholder={t('Job Key')}
          style={{ width: 180 }}
          value={jobKey}
          onChange={(e) => setJobKey(e.target.value)}
          allowClear
        />
        <Input.Search
          placeholder={t('Queue item ID/key/reference')}
          style={{ width: 240 }}
          value={queueItem}
          onChange={(e) => setQueueItem(e.target.value)}
          onSearch={(value) => setQueueItem(value)}
          allowClear
        />
        <Input.Search placeholder={t('Search message')} style={{ width: 250 }} onSearch={setSearch} allowClear />
        <Button onClick={() => refresh()} icon={<ReloadOutlined />}>
          {t('Refresh')}
        </Button>
      </Space>
      {meta?.jobKeys?.length ? (
        <Space style={{ marginBottom: 16 }} wrap>
          <span>{t('Resolved job keys')}:</span>
          {meta.jobKeys.map((key: string) => (
            <Tag key={key}>{key}</Tag>
          ))}
        </Space>
      ) : null}

      <Table
        dataSource={data || []}
        columns={columns}
        rowKey="Id"
        loading={loading}
        size="small"
        pagination={{ pageSize: 100 }}
        scroll={{ x: 1200 }}
      />
    </div>
  );
};
