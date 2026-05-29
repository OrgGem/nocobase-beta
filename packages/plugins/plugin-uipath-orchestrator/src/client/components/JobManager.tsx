/**
 * Job Manager — table with filters, actions (Start, Stop, Kill, Restart), detail drawer
 */

import React, { useState } from 'react';
import { Alert, Table, Tag, Button, Space, Input, Select, Drawer, Descriptions, Popconfirm, message } from 'antd';
import { StopOutlined, ReloadOutlined, DeleteOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useCurrentInstance } from '../context/InstanceContext';
import { toUiPathArray, useUiPathRequest } from '../hooks/useUiPathRequest';
import { useT } from '../locale';

const stateColors: Record<string, string> = {
  Faulted: 'red',
  Stopped: 'orange',
  Running: 'blue',
  Pending: 'gold',
  Successful: 'green',
  Suspended: 'purple',
};

const JOB_STATES = ['Pending', 'Running', 'Successful', 'Faulted', 'Stopped', 'Suspended', 'Resumed'];
const escapeODataString = (value: string) => value.replace(/'/g, "''");

export const JobManager: React.FC = () => {
  const t = useT();
  const api = useAPIClient();
  const { instanceId, folderId, folderKey } = useCurrentInstance();
  const [stateFilter, setStateFilter] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [selectedJob, setSelectedJob] = useState<any>(null);

  const filterParts: string[] = [];
  if (stateFilter) filterParts.push(`State eq '${stateFilter}'`);
  if (search) filterParts.push(`contains(ReleaseName, '${escapeODataString(search)}')`);

  const { data, loading, error, refresh } = useUiPathRequest('uipathJobs', 'list', {
    filter: filterParts.join(' and ') || undefined,
    top: 50,
    count: true,
    orderby: 'CreationTime desc',
  });
  const jobs = toUiPathArray(data);

  const handleAction = async (action: string, jobId: number) => {
    try {
      await api.request({
        url: `uipathJobs:${action}`,
        params: { instanceId, folderId, folderKey, filterByTk: jobId },
      });
      message.success(t(`Job ${action} requested`));
      refresh();
    } catch (err: any) {
      message.error(err.message);
    }
  };

  const columns = [
    { title: t('ID'), dataIndex: 'Id', width: 80 },
    { title: t('Process'), dataIndex: 'ReleaseName', ellipsis: true },
    {
      title: t('State'),
      dataIndex: 'State',
      width: 100,
      render: (s: string) => <Tag color={stateColors[s] || 'default'}>{s}</Tag>,
    },
    { title: t('Machine'), dataIndex: 'HostMachineName', width: 150, ellipsis: true },
    {
      title: t('Started'),
      dataIndex: 'StartTime',
      width: 180,
      render: (v: string) => (v ? new Date(v).toLocaleString() : '-'),
    },
    { title: t('Info'), dataIndex: 'Info', ellipsis: true },
    {
      title: t('Actions'),
      width: 180,
      render: (_: any, record: any) => (
        <Space size="small">
          {record.State === 'Running' && (
            <>
              <Popconfirm title={t('Soft stop this job?')} onConfirm={() => handleAction('stop', record.Id)}>
                <Button size="small" icon={<StopOutlined />} />
              </Popconfirm>
              <Popconfirm title={t('Kill this job?')} onConfirm={() => handleAction('kill', record.Id)}>
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
          {['Faulted', 'Stopped'].includes(record.State) && (
            <Popconfirm title={t('Restart this job?')} onConfirm={() => handleAction('restart', record.Id)}>
              <Button size="small" icon={<ReloadOutlined />} />
            </Popconfirm>
          )}
          <Button size="small" onClick={() => setSelectedJob(record)}>
            {t('Detail')}
          </Button>
        </Space>
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
          placeholder={t('Filter by state')}
          allowClear
          style={{ width: 160 }}
          value={stateFilter}
          onChange={setStateFilter}
          options={JOB_STATES.map((s) => ({ label: s, value: s }))}
        />
        <Input.Search placeholder={t('Search process name')} style={{ width: 250 }} onSearch={setSearch} allowClear />
        <Button onClick={() => refresh()} icon={<ReloadOutlined />}>
          {t('Refresh')}
        </Button>
      </Space>

      <Table
        dataSource={jobs}
        columns={columns}
        rowKey="Id"
        loading={loading}
        size="small"
        pagination={{ pageSize: 50, showTotal: (total) => `${total} ${t('jobs')}` }}
      />

      <Drawer title={t('Job Detail')} open={!!selectedJob} onClose={() => setSelectedJob(null)} width={600}>
        {selectedJob && (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="ID">{selectedJob.Id}</Descriptions.Item>
            <Descriptions.Item label="Key">{selectedJob.Key}</Descriptions.Item>
            <Descriptions.Item label="State">
              <Tag color={stateColors[selectedJob.State]}>{selectedJob.State}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Process">{selectedJob.ReleaseName}</Descriptions.Item>
            <Descriptions.Item label="Machine">{selectedJob.HostMachineName}</Descriptions.Item>
            <Descriptions.Item label="Source">{selectedJob.Source}</Descriptions.Item>
            <Descriptions.Item label="Start">
              {selectedJob.StartTime ? new Date(selectedJob.StartTime).toLocaleString() : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="End">
              {selectedJob.EndTime ? new Date(selectedJob.EndTime).toLocaleString() : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Info">{selectedJob.Info || '-'}</Descriptions.Item>
            <Descriptions.Item label="Input Args">
              <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 12 }}>{selectedJob.InputArguments || '-'}</pre>
            </Descriptions.Item>
            <Descriptions.Item label="Output Args">
              <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 12 }}>{selectedJob.OutputArguments || '-'}</pre>
            </Descriptions.Item>
          </Descriptions>
        )}
      </Drawer>
    </div>
  );
};
