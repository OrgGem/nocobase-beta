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
const escapeODataString = (value: string) => value.replace(/'/g, "''");

export const LogExplorer: React.FC = () => {
  const t = useT();
  const [level, setLevel] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [jobKey, setJobKey] = useState('');

  const filterParts: string[] = [];
  if (level) filterParts.push(`Level eq '${level}'`);
  if (jobKey) filterParts.push(`JobKey eq '${escapeODataString(jobKey)}'`);
  if (search) filterParts.push(`contains(Message, '${escapeODataString(search)}')`);

  const { data, loading, refresh } = useUiPathRequest('uipathRobotLogs', 'list', {
    filter: filterParts.join(' and ') || undefined,
    top: 100,
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
        <Input.Search placeholder={t('Search message')} style={{ width: 250 }} onSearch={setSearch} allowClear />
        <Button onClick={() => refresh()} icon={<ReloadOutlined />}>
          {t('Refresh')}
        </Button>
      </Space>

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
