/**
 * Queue Manager — definitions + items table, retry/review actions
 */

import React, { useState } from 'react';
import { Alert, Table, Tag, Tabs, Space, Button, Select, Drawer, Descriptions, Input, Switch } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useCurrentInstance } from '../context/InstanceContext';
import { toUiPathArray, useUiPathRequest } from '../hooks/useUiPathRequest';
import { useT } from '../locale';
import { QueueItemTracePanel } from './QueueItemTracePanel';
import { combineFilters, containsFilter, dateRangeFilter, equalsFilter } from '../utils/odataFilters';

const statusColors: Record<string, string> = {
  New: 'blue',
  InProgress: 'processing',
  Failed: 'red',
  Successful: 'green',
  Abandoned: 'default',
  Retried: 'orange',
  Deleted: 'default',
};
const QUEUE_PRIORITIES = ['Low', 'Normal', 'High'];
const QUEUE_DATE_FIELDS = ['CreationTime', 'StartProcessing', 'EndProcessing'];

export const QueueManager: React.FC = () => {
  const t = useT();
  const { dateRange, queueFilter } = useCurrentInstance();
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [priorityFilter, setPriorityFilter] = useState<string | undefined>();
  const [queueDefinitionId, setQueueDefinitionId] = useState<number | undefined>();
  const [reference, setReference] = useState('');
  const [exceptionOnly, setExceptionOnly] = useState(false);
  const [dateField, setDateField] = useState('CreationTime');
  const [selectedItem, setSelectedItem] = useState<any>(null);

  const definitionFilter = containsFilter('Name', queueFilter);
  const itemFilter = combineFilters([
    equalsFilter('Status', statusFilter),
    equalsFilter('Priority', priorityFilter),
    equalsFilter('QueueDefinitionId', queueDefinitionId),
    queueFilter && /^\d+$/.test(queueFilter.trim())
      ? equalsFilter('QueueDefinitionId', Number(queueFilter.trim()))
      : containsFilter('Reference', queueFilter),
    containsFilter('Reference', reference),
    exceptionOnly ? 'ProcessingExceptionType ne null' : undefined,
    dateRangeFilter(dateField, dateRange),
  ]);

  const {
    data: defs,
    loading: defsLoading,
    error: defsError,
  } = useUiPathRequest('uipathQueues', 'definitions', {
    filter: definitionFilter,
    top: 100,
    orderby: 'Name asc',
  });
  const {
    data: items,
    loading: itemsLoading,
    error: itemsError,
    refresh,
  } = useUiPathRequest('uipathQueues', 'items', {
    filter: itemFilter,
    top: 50,
    count: true,
  });
  const definitions = toUiPathArray(defs);
  const queueItems = toUiPathArray(items);

  const defColumns = [
    { title: t('Name'), dataIndex: 'Name' },
    { title: t('Description'), dataIndex: 'Description', ellipsis: true },
    { title: t('Max Retries'), dataIndex: 'MaxNumberOfRetries', width: 100 },
    {
      title: t('Auto Retry'),
      dataIndex: 'AcceptAutomaticallyRetry',
      width: 100,
      render: (v: boolean) => (v ? 'Yes' : 'No'),
    },
  ];

  const itemColumns = [
    { title: t('ID'), dataIndex: 'Id', width: 80 },
    {
      title: t('Status'),
      dataIndex: 'Status',
      width: 100,
      render: (s: string) => <Tag color={statusColors[s]}>{s}</Tag>,
    },
    { title: t('Priority'), dataIndex: 'Priority', width: 80 },
    { title: t('Reference'), dataIndex: 'Reference', width: 160, ellipsis: true },
    { title: t('Queue'), dataIndex: 'QueueDefinitionId', width: 80 },
    {
      title: t('Created'),
      dataIndex: 'CreationTime',
      width: 180,
      render: (v: string) => (v ? new Date(v).toLocaleString() : '-'),
    },
    { title: t('Retry'), dataIndex: 'RetryNumber', width: 60 },
    {
      title: t('Actions'),
      width: 100,
      render: (_: any, rec: any) => (
        <Button size="small" onClick={() => setSelectedItem(rec)}>
          {t('Detail')}
        </Button>
      ),
    },
  ];

  return (
    <div>
      <Tabs
        items={[
          {
            key: 'definitions',
            label: t('Queue Definitions'),
            children: (
              <>
                {defsError ? (
                  <Alert
                    type="error"
                    showIcon
                    message={t('Failed')}
                    description={defsError.message}
                    style={{ marginBottom: 16 }}
                  />
                ) : null}
                <Table dataSource={definitions} columns={defColumns} rowKey="Id" loading={defsLoading} size="small" />
              </>
            ),
          },
          {
            key: 'items',
            label: t('Queue Items'),
            children: (
              <>
                {itemsError ? (
                  <Alert
                    type="error"
                    showIcon
                    message={t('Failed')}
                    description={itemsError.message}
                    style={{ marginBottom: 16 }}
                  />
                ) : null}
                <Space style={{ marginBottom: 16 }} wrap>
                  <Select
                    placeholder={t('Queue')}
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    style={{ width: 220 }}
                    value={queueDefinitionId}
                    onChange={setQueueDefinitionId}
                    options={definitions.map((definition: any) => ({
                      label: definition.Name,
                      value: definition.Id,
                    }))}
                  />
                  <Select
                    placeholder={t('Status')}
                    allowClear
                    style={{ width: 140 }}
                    value={statusFilter}
                    onChange={setStatusFilter}
                    options={['New', 'InProgress', 'Failed', 'Successful', 'Abandoned', 'Retried'].map((s) => ({
                      label: s,
                      value: s,
                    }))}
                  />
                  <Select
                    placeholder={t('Priority')}
                    allowClear
                    style={{ width: 120 }}
                    value={priorityFilter}
                    onChange={setPriorityFilter}
                    options={QUEUE_PRIORITIES.map((value) => ({ label: value, value }))}
                  />
                  <Input
                    placeholder={t('Reference')}
                    style={{ width: 180 }}
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    allowClear
                  />
                  <Select
                    value={dateField}
                    style={{ width: 160 }}
                    onChange={setDateField}
                    options={QUEUE_DATE_FIELDS.map((value) => ({ label: value, value }))}
                  />
                  <Space>
                    <Switch checked={exceptionOnly} onChange={setExceptionOnly} />
                    <span>{t('Exceptions only')}</span>
                  </Space>
                  <Button onClick={() => refresh()} icon={<ReloadOutlined />}>
                    {t('Refresh')}
                  </Button>
                </Space>
                <Table
                  dataSource={queueItems}
                  columns={itemColumns}
                  rowKey="Id"
                  loading={itemsLoading}
                  size="small"
                  pagination={{ pageSize: 50 }}
                />
              </>
            ),
          },
        ]}
      />

      <Drawer title={t('Queue Item Detail')} open={!!selectedItem} onClose={() => setSelectedItem(null)} width={600}>
        {selectedItem && (
          <Tabs
            items={[
              {
                key: 'info',
                label: t('Information'),
                children: (
                  <Descriptions column={1} bordered size="small">
                    <Descriptions.Item label="ID">{selectedItem.Id}</Descriptions.Item>
                    <Descriptions.Item label="Status">
                      <Tag color={statusColors[selectedItem.Status]}>{selectedItem.Status}</Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label="Reference">{selectedItem.Reference || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Priority">{selectedItem.Priority}</Descriptions.Item>
                    <Descriptions.Item label="Retry">{selectedItem.RetryNumber}</Descriptions.Item>
                    <Descriptions.Item label="Specific Content">
                      <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 12 }}>
                        {JSON.stringify(selectedItem.SpecificContent, null, 2)}
                      </pre>
                    </Descriptions.Item>
                    {selectedItem.ProcessingException && (
                      <Descriptions.Item label="Exception">
                        <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 12, color: 'red' }}>
                          {JSON.stringify(selectedItem.ProcessingException, null, 2)}
                        </pre>
                      </Descriptions.Item>
                    )}
                  </Descriptions>
                ),
              },
              {
                key: 'trace',
                label: t('Execution Trace'),
                children: <QueueItemTracePanel itemId={selectedItem.Id} />,
              },
            ]}
          />
        )}
      </Drawer>
    </div>
  );
};
