/**
 * Job Manager — table with filters, actions (Start, Stop, Kill, Restart), detail drawer
 */

import React, { useState } from 'react';
import { Alert, Table, Tag, Button, Space, Input, Select, Drawer, Descriptions, Tabs } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { CorrelationTracePanel } from '../CorrelationTracePanel';
import { useCurrentInstance } from '../context/InstanceContext';
import { toUiPathArray, useUiPathRequest } from '../hooks/useUiPathRequest';
import { useT } from '../locale';
import { combineFilters, containsFilter, dateRangeFilter, equalsFilter, textAnyFilter } from '../utils/odataFilters';

const stateColors: Record<string, string> = {
  Faulted: 'red',
  Stopped: 'orange',
  Running: 'blue',
  Pending: 'gold',
  Successful: 'green',
  Suspended: 'purple',
};

const JOB_STATES = ['Pending', 'Running', 'Successful', 'Faulted', 'Stopped', 'Suspended', 'Resumed'];
const JOB_DATE_FIELDS = ['CreationTime', 'StartTime', 'EndTime'];
const JOB_SOURCES = ['Manual', 'Schedule', 'Queue', 'Process', 'Trigger'];

export const JobManager: React.FC = () => {
  const t = useT();
  const { dateRange, processFilter, instanceId, folderId, folderKey, folderPath, folderReady } = useCurrentInstance();
  const [stateFilter, setStateFilter] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [jobKey, setJobKey] = useState('');
  const [source, setSource] = useState<string | undefined>();
  const [machine, setMachine] = useState('');
  const [dateField, setDateField] = useState('CreationTime');
  const [selectedJob, setSelectedJob] = useState<any>(null);

  const filter = combineFilters([
    equalsFilter('State', stateFilter),
    textAnyFilter(['ReleaseName', 'ReleaseKey'], processFilter),
    textAnyFilter(['ReleaseName', 'ReleaseKey'], search),
    equalsFilter('Key', jobKey.trim() || undefined),
    equalsFilter('Source', source),
    containsFilter('HostMachineName', machine),
    dateRangeFilter(dateField, dateRange),
  ]);

  const { data, loading, error, refresh } = useUiPathRequest('uipathJobs', 'list', {
    filter,
    top: 50,
    count: true,
    orderby: 'CreationTime desc',
  });
  const jobs = toUiPathArray(data);

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
      width: 100,
      render: (_: any, record: any) => (
        <Button size="small" onClick={() => setSelectedJob(record)}>
          {t('Detail')}
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
          placeholder={t('Filter by state')}
          allowClear
          style={{ width: 160 }}
          value={stateFilter}
          onChange={setStateFilter}
          options={JOB_STATES.map((s) => ({ label: s, value: s }))}
        />
        <Input.Search placeholder={t('Search process name')} style={{ width: 250 }} onSearch={setSearch} allowClear />
        <Input
          placeholder={t('Job Key')}
          style={{ width: 180 }}
          value={jobKey}
          onChange={(event) => setJobKey(event.target.value)}
          allowClear
        />
        <Select
          placeholder={t('Source')}
          allowClear
          style={{ width: 140 }}
          value={source}
          onChange={setSource}
          options={JOB_SOURCES.map((value) => ({ label: value, value }))}
        />
        <Input
          placeholder={t('Machine')}
          style={{ width: 180 }}
          value={machine}
          onChange={(event) => setMachine(event.target.value)}
          allowClear
        />
        <Select
          value={dateField}
          style={{ width: 150 }}
          onChange={setDateField}
          options={JOB_DATE_FIELDS.map((value) => ({ label: value, value }))}
        />
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

      <Drawer title={t('Job Detail')} open={!!selectedJob} onClose={() => setSelectedJob(null)} width={760}>
        {selectedJob && (
          <Tabs
            items={[
              {
                key: 'information',
                label: t('Information'),
                children: (
                  <Descriptions column={1} bordered size="small">
                    <Descriptions.Item label={t('ID')}>{selectedJob.Id}</Descriptions.Item>
                    <Descriptions.Item label={t('Key')}>{selectedJob.Key}</Descriptions.Item>
                    <Descriptions.Item label={t('State')}>
                      <Tag color={stateColors[selectedJob.State]}>{selectedJob.State}</Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label={t('Process')}>{selectedJob.ReleaseName}</Descriptions.Item>
                    <Descriptions.Item label={t('Machine')}>{selectedJob.HostMachineName}</Descriptions.Item>
                    <Descriptions.Item label={t('Source')}>{selectedJob.Source}</Descriptions.Item>
                    <Descriptions.Item label={t('Start')}>
                      {selectedJob.StartTime ? new Date(selectedJob.StartTime).toLocaleString() : '-'}
                    </Descriptions.Item>
                    <Descriptions.Item label={t('End')}>
                      {selectedJob.EndTime ? new Date(selectedJob.EndTime).toLocaleString() : '-'}
                    </Descriptions.Item>
                    <Descriptions.Item label={t('Info')}>{selectedJob.Info || '-'}</Descriptions.Item>
                    <Descriptions.Item label={t('Input Args')}>
                      <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 12 }}>
                        {selectedJob.InputArguments || '-'}
                      </pre>
                    </Descriptions.Item>
                    <Descriptions.Item label={t('Output Args')}>
                      <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 12 }}>
                        {selectedJob.OutputArguments || '-'}
                      </pre>
                    </Descriptions.Item>
                  </Descriptions>
                ),
              },
              {
                key: 'trace',
                label: t('Execution Trace'),
                children: (
                  <CorrelationTracePanel
                    target={{ kind: 'job', id: selectedJob.Id, jobKey: selectedJob.Key }}
                    instanceId={instanceId}
                    folderId={folderId}
                    folderKey={folderKey}
                    folderPath={folderPath}
                    folderReady={folderReady}
                  />
                ),
              },
            ]}
          />
        )}
      </Drawer>
    </div>
  );
};
