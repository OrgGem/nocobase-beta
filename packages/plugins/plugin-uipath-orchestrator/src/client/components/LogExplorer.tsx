/**
 * Log Explorer — robot logs with level/time/process/jobKey filters
 */

import React, { useState, useEffect } from 'react';
import {
  Alert,
  Table,
  Tag,
  Space,
  Input,
  Select,
  Button,
  Drawer,
  Spin,
  List,
  Empty,
  Tabs,
  Descriptions,
  message,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useCurrentInstance } from '../context/InstanceContext';
import { toUiPathArray, useUiPathRequest } from '../hooks/useUiPathRequest';
import { useT } from '../locale';
import { QueueItemTracePanel } from './QueueItemTracePanel';

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
  const api = useAPIClient();
  const { instanceId, folderId, folderKey } = useCurrentInstance();

  const [level, setLevel] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [jobKey, setJobKey] = useState('');
  const [queueItem, setQueueItem] = useState('');

  const [tracingLog, setTracingLog] = useState<any>(null);
  const [traceData, setTraceData] = useState<any>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [selectedQueueItem, setSelectedQueueItem] = useState<any>(null);

  useEffect(() => {
    if (!tracingLog) {
      setTraceData(null);
      setSelectedQueueItem(null);
      return;
    }
    setTraceLoading(true);
    api
      .request({
        url: 'uipathRobotLogs:traceQueueItem',
        params: {
          instanceId,
          folderId,
          folderKey,
          logId: tracingLog.Id,
          timeStamp: tracingLog.TimeStamp,
          jobKey: tracingLog.JobKey,
        },
      })
      .then((res) => {
        setTraceData(res.data);
        setTraceLoading(false);
      })
      .catch((err) => {
        message.error(err.message);
        setTraceLoading(false);
      });
  }, [tracingLog, instanceId, folderId, folderKey, api]);

  const { data, meta, loading, error, refresh } = useUiPathRequest('uipathRobotLogs', 'search', {
    level,
    jobKey: jobKey || undefined,
    message: search || undefined,
    queueItem: queueItem || undefined,
    top: 100,
    count: true,
    orderby: 'TimeStamp desc',
  });
  const logs = toUiPathArray(data);
  const jobKeys =
    meta && typeof meta === 'object' && Array.isArray((meta as { jobKeys?: unknown }).jobKeys)
      ? (meta as { jobKeys: string[] }).jobKeys
      : [];

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
    {
      title: t('Actions'),
      width: 120,
      render: (_: any, rec: any) => (
        <Button size="small" onClick={() => setTracingLog(rec)}>
          {t('Trace Queue')}
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
      {jobKeys.length ? (
        <Space style={{ marginBottom: 16 }} wrap>
          <span>{t('Resolved job keys')}:</span>
          {jobKeys.map((key: string) => (
            <Tag key={key}>{key}</Tag>
          ))}
        </Space>
      ) : null}

      <Table
        dataSource={logs}
        columns={columns}
        rowKey="Id"
        loading={loading}
        size="small"
        pagination={{ pageSize: 100 }}
        scroll={{ x: 1200 }}
      />

      <Drawer
        title={t('Trace Queue Item from Log')}
        open={!!tracingLog}
        onClose={() => {
          setTracingLog(null);
          setSelectedQueueItem(null);
        }}
        width={650}
      >
        {traceLoading ? (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <Spin size="large" />
          </div>
        ) : traceData?.queueItems?.length > 0 ? (
          <div>
            <h4 style={{ marginBottom: 16 }}>{t('Correlated Queue Items at Log Timestamp')}</h4>
            <List
              dataSource={traceData.queueItems}
              renderItem={(item: any) => (
                <List.Item
                  actions={[
                    <Button key="trace" type="link" onClick={() => setSelectedQueueItem(item)}>
                      {t('Detail & TraceLogs')}
                    </Button>,
                  ]}
                >
                  <List.Item.Meta
                    title={`Queue Item ID: ${item.Id}`}
                    description={
                      <Space>
                        <Tag color={item.Status === 'Failed' ? 'red' : item.Status === 'Successful' ? 'green' : 'blue'}>
                          {item.Status}
                        </Tag>
                        {item.Reference && <span>Ref: {item.Reference}</span>}
                        <span>Start: {new Date(item.StartProcessing).toLocaleTimeString()}</span>
                      </Space>
                    }
                  />
                </List.Item>
              )}
            />

            {selectedQueueItem && (
              <div style={{ marginTop: 24, borderTop: '1px solid #f0f0f0', paddingTop: 24 }}>
                <Tabs
                  items={[
                    {
                      key: 'info',
                      label: t('Queue Item Info'),
                      children: (
                        <Descriptions column={1} bordered size="small">
                          <Descriptions.Item label="ID">{selectedQueueItem.Id}</Descriptions.Item>
                          <Descriptions.Item label="Status">{selectedQueueItem.Status}</Descriptions.Item>
                          <Descriptions.Item label="Reference">{selectedQueueItem.Reference || '-'}</Descriptions.Item>
                          <Descriptions.Item label="Specific Content">
                            <pre style={{ maxHeight: 150, overflow: 'auto', fontSize: 11 }}>
                              {JSON.stringify(selectedQueueItem.SpecificContent, null, 2)}
                            </pre>
                          </Descriptions.Item>
                        </Descriptions>
                      ),
                    },
                    {
                      key: 'trace',
                      label: t('Chronological Trace Logs'),
                      children: <QueueItemTracePanel itemId={selectedQueueItem.Id} />,
                    },
                  ]}
                />
              </div>
            )}
          </div>
        ) : (
          <Empty description={t('No active queue item found at this timestamp')} />
        )}
      </Drawer>
    </div>
  );
};
