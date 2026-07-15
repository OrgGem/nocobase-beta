import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Row,
  Col,
  Empty,
  message,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { useApp } from '@nocobase/client-v2';
import { useCurrentInstance } from '../context/InstanceContext';
import { toUiPathArray, useUiPathRequest } from '../hooks/useUiPathRequest';
import { useT } from '../locale';
import { getActionResponseBody, getListRows } from '../utils/apiResponse';
import { dateToOData } from '../utils/odataFilters';

type RowData = Record<string, unknown>;

const TRIGGER_TYPES = [
  { label: 'Direct', value: 'direct' },
  { label: 'Schedule', value: 'schedule' },
  { label: 'Queue', value: 'queue' },
];

const statusColors: Record<string, string> = {
  healthy: 'green',
  running: 'blue',
  faulted: 'red',
  idle: 'default',
};

function rowId(row: RowData): number | undefined {
  const id = row.id ?? row.Id;
  return typeof id === 'number' ? id : Number(id) || undefined;
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isTriggerForType(trigger: RowData, triggerType?: string): boolean {
  if (triggerType === 'queue') {
    return Boolean(trigger.QueueDefinitionId || trigger.QueueDefinitionName);
  }

  if (triggerType === 'schedule') {
    return Boolean(trigger.StartProcessCron || trigger.StartProcessCronSummary || trigger.StartProcessNextOccurrence);
  }

  return false;
}

export const BusinessMonitor: React.FC = () => {
  const t = useT();
  const api = useApp().apiClient;
  const { instanceId, folderId, folderKey, folderPath, folderReady, folders, dateRange } = useCurrentInstance();
  const [selectedProcessId, setSelectedProcessId] = useState<number | undefined>();
  const [processModalOpen, setProcessModalOpen] = useState(false);
  const [stepModalOpen, setStepModalOpen] = useState(false);
  const [editingProcess, setEditingProcess] = useState<RowData | null>(null);
  const [editingStep, setEditingStep] = useState<RowData | null>(null);
  const [snapshot, setSnapshot] = useState<RowData | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [correlation, setCorrelation] = useState<{ title: string; loading: boolean; data: RowData | null } | null>(
    null,
  );
  const [processForm] = Form.useForm();
  const [stepForm] = Form.useForm();
  const stepFolderId = numericValue(Form.useWatch('folderId', stepForm));
  const stepTriggerType = (Form.useWatch('triggerType', stepForm) as string | undefined) || 'direct';

  const selectedStepFolder = folders.find((item) => item.folderId === stepFolderId);
  const effectiveStepFolderId = stepModalOpen ? stepFolderId ?? folderId : folderId;
  const effectiveStepFolderKey = stepModalOpen
    ? selectedStepFolder?.folderKey || (stepFolderId ? null : folderKey)
    : folderKey;
  const stepFolderParams = useMemo(
    () => ({
      folderId: effectiveStepFolderId ?? undefined,
      folderKey: effectiveStepFolderKey ?? undefined,
    }),
    [effectiveStepFolderId, effectiveStepFolderKey],
  );

  const {
    data: processesData,
    loading: processesLoading,
    refresh: refreshProcesses,
  } = useRequest(() =>
    api.resource('uipathMonitorProcesses').list({
      pageSize: 100,
      filter: instanceId ? { instanceId } : {},
      sort: ['code'],
    }),
  );
  const processes = getListRows<RowData>(processesData);

  const {
    data: stepsData,
    loading: stepsLoading,
    refresh: refreshSteps,
  } = useRequest(
    () =>
      api.resource('uipathMonitorProcessSteps').list({
        pageSize: 100,
        filter: { processId: selectedProcessId },
        sort: ['stepOrder'],
      }),
    { ready: Boolean(selectedProcessId), refreshDeps: [selectedProcessId] },
  );
  const steps = getListRows<RowData>(stepsData);

  const {
    data: releasesData,
    loading: releasesLoading,
    error: releasesError,
  } = useUiPathRequest('uipathProcesses', 'list', {
    ...stepFolderParams,
    top: 500,
    orderby: 'Name asc',
  });
  const releases = toUiPathArray<RowData>(releasesData);
  const { data: queueDefsData, loading: queuesLoading } = useUiPathRequest('uipathQueues', 'definitions', {
    ...stepFolderParams,
    top: 500,
    orderby: 'Name asc',
  });
  const queueDefinitions = toUiPathArray<RowData>(queueDefsData);
  const {
    data: schedulesData,
    loading: schedulesLoading,
    error: schedulesError,
  } = useUiPathRequest('uipathTriggers', 'processSchedules', {
    ...stepFolderParams,
    top: 500,
    orderby: 'Name asc',
  });
  const processSchedules = toUiPathArray<RowData>(schedulesData);

  const triggerTypeOptions = useMemo(
    () => TRIGGER_TYPES.map((item) => ({ label: t(item.label), value: item.value })),
    [t],
  );

  const releaseOptions = useMemo(() => {
    const options = new Map<number, { label: string; value: number }>();

    for (const release of releases) {
      const id = rowId(release);
      if (!id) continue;
      options.set(id, {
        label: `${release.Name || ''} (${release.ProcessKey || release.Key || id})`,
        value: id,
      });
    }

    for (const trigger of processSchedules) {
      const releaseId = numericValue(trigger.ReleaseId);
      if (!releaseId || options.has(releaseId)) continue;
      options.set(releaseId, {
        label: `${trigger.ReleaseName || trigger.PackageName || ''} (${trigger.ReleaseKey || releaseId})`,
        value: releaseId,
      });
    }

    return Array.from(options.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [processSchedules, releases]);

  const queueOptions = useMemo(() => {
    const options = new Map<number, { label: string; value: number }>();

    for (const queue of queueDefinitions) {
      const id = rowId(queue);
      if (!id) continue;
      options.set(id, { label: String(queue.Name || id), value: id });
    }

    for (const trigger of processSchedules) {
      const queueDefinitionId = numericValue(trigger.QueueDefinitionId);
      if (!queueDefinitionId || options.has(queueDefinitionId)) continue;
      options.set(queueDefinitionId, {
        label: String(trigger.QueueDefinitionName || queueDefinitionId),
        value: queueDefinitionId,
      });
    }

    return Array.from(options.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [processSchedules, queueDefinitions]);

  const triggerOptions = useMemo(
    () =>
      processSchedules
        .filter((trigger) => isTriggerForType(trigger, stepTriggerType))
        .map((trigger) => ({
          label: `${trigger.Name || trigger.Id} - ${trigger.ReleaseName || trigger.PackageName || '-'}`,
          value: String(trigger.Name || trigger.Id),
        })),
    [processSchedules, stepTriggerType],
  );

  useEffect(() => {
    if (!selectedProcessId && processes.length) {
      setSelectedProcessId(rowId(processes[0]));
    }
  }, [processes, selectedProcessId]);

  const selectedProcess = processes.find((process) => rowId(process) === selectedProcessId);

  const saveProcess = async () => {
    const values = await processForm.validateFields();
    const payload = { ...values, instanceId };
    if (editingProcess) {
      await api.resource('uipathMonitorProcesses').update({ filterByTk: rowId(editingProcess), values: payload });
    } else {
      const response = await api.resource('uipathMonitorProcesses').create({ values: payload });
      const created = getActionResponseBody(response) as RowData;
      setSelectedProcessId(
        rowId(created.data && typeof created.data === 'object' ? (created.data as RowData) : created),
      );
    }
    message.success(t('Saved'));
    setProcessModalOpen(false);
    setEditingProcess(null);
    processForm.resetFields();
    refreshProcesses();
  };

  const deleteProcess = async (process: RowData) => {
    await api.resource('uipathMonitorProcesses').destroy({ filterByTk: rowId(process) });
    if (selectedProcessId === rowId(process)) {
      setSelectedProcessId(undefined);
      setSnapshot(null);
    }
    message.success(t('Deleted'));
    refreshProcesses();
  };

  const saveStep = async () => {
    const values = await stepForm.validateFields();
    const releaseId = numericValue(values.releaseId);
    const release = releases.find((item) => rowId(item) === releaseId);
    const trigger = processSchedules.find(
      (item) => String(item.Name || item.Id) === values.scheduleName && isTriggerForType(item, values.triggerType),
    );
    const selectedFolderId = numericValue(values.folderId);
    const folder = folders.find((item) => item.folderId === selectedFolderId);
    const triggerReleaseId = numericValue(trigger?.ReleaseId);
    const triggerQueueDefinitionId = numericValue(trigger?.QueueDefinitionId);
    const selectedQueueDefinitionId = numericValue(values.queueDefinitionId);
    const queueDefinitionId =
      values.triggerType === 'queue'
        ? selectedQueueDefinitionId || triggerQueueDefinitionId || null
        : selectedQueueDefinitionId || null;
    const queue = queueDefinitions.find((item) => rowId(item) === queueDefinitionId);
    const payload = {
      ...values,
      processId: selectedProcessId,
      folderKey: folder?.folderKey || null,
      folderPath: folder?.fullyQualifiedName || folder?.displayName || null,
      releaseId: releaseId || triggerReleaseId || null,
      releaseKey: release?.Key || trigger?.ReleaseKey || null,
      processKey: release?.ProcessKey || trigger?.PackageName || trigger?.ReleaseName || null,
      processName: release?.Name || trigger?.ReleaseName || trigger?.PackageName || values.name,
      scheduleName:
        values.triggerType === 'direct' ? values.scheduleName || null : trigger?.Name || values.scheduleName || null,
      queueDefinitionId,
      queueName: queue?.Name || trigger?.QueueDefinitionName || values.queueName || null,
    };

    if (editingStep) {
      await api.resource('uipathMonitorProcessSteps').update({ filterByTk: rowId(editingStep), values: payload });
    } else {
      await api.resource('uipathMonitorProcessSteps').create({ values: payload });
    }
    message.success(t('Saved'));
    setStepModalOpen(false);
    setEditingStep(null);
    stepForm.resetFields();
    refreshSteps();
  };

  const deleteStep = async (step: RowData) => {
    await api.resource('uipathMonitorProcessSteps').destroy({ filterByTk: rowId(step) });
    message.success(t('Deleted'));
    refreshSteps();
  };

  const loadSnapshot = async () => {
    if (!selectedProcessId || !instanceId || !folderReady) return;
    setSnapshotLoading(true);
    try {
      const response = await api.request({
        url: 'uipathProcessMonitor:snapshot',
        params: {
          processId: selectedProcessId,
          instanceId,
          folderId,
          folderKey,
          folderPath,
          from: dateToOData(dateRange?.[0]),
          to: dateToOData(dateRange?.[1]),
        },
      });
      setSnapshot(getActionResponseBody(response) as RowData);
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('Failed'));
    } finally {
      setSnapshotLoading(false);
    }
  };

  const applyTriggerSelection = (value?: string) => {
    const trigger = processSchedules.find((item) => String(item.Name || item.Id) === value);
    if (!trigger) return;

    const releaseId = numericValue(trigger.ReleaseId);
    const queueDefinitionId = numericValue(trigger.QueueDefinitionId);
    const updates: RowData = {};

    if (releaseId) {
      updates.releaseId = releaseId;
    }
    if (stepTriggerType === 'queue' && queueDefinitionId) {
      updates.queueDefinitionId = queueDefinitionId;
    }
    if (!stepForm.getFieldValue('name') && trigger.Name) {
      updates.name = trigger.Name;
    }

    stepForm.setFieldsValue(updates);
  };

  const openCorrelation = async (type: 'job' | 'queue' | 'log', record: RowData) => {
    if (!instanceId || !folderReady) return;
    const title =
      type === 'job' ? t('Job Correlation') : type === 'queue' ? t('Queue Correlation') : t('Log Correlation');
    setCorrelation({ title, loading: true, data: null });
    try {
      const url =
        type === 'job'
          ? 'uipathCorrelations:fromJob'
          : type === 'queue'
            ? 'uipathCorrelations:fromQueueItem'
            : 'uipathCorrelations:fromLog';
      const params =
        type === 'job'
          ? { jobId: record.Id || record.id }
          : type === 'queue'
            ? { queueItemId: record.Id || record.id }
            : { logId: record.Id || record.id, jobKey: record.JobKey, timeStamp: record.TimeStamp };
      const response = await api.request({ url, params: { instanceId, folderId, folderKey, folderPath, ...params } });
      setCorrelation({ title, loading: false, data: getActionResponseBody(response) as RowData });
    } catch (error) {
      setCorrelation({ title, loading: false, data: { error: error instanceof Error ? error.message : t('Failed') } });
    }
  };

  const processColumns = [
    { title: t('Code'), dataIndex: 'code', width: 140 },
    { title: t('Name'), dataIndex: 'name', ellipsis: true },
    { title: t('Owner'), dataIndex: 'owner', width: 160 },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      width: 90,
      render: (value: boolean) => (value ? <Tag color="green">{t('Enabled')}</Tag> : <Tag>{t('Disabled')}</Tag>),
    },
    {
      title: t('Actions'),
      width: 120,
      render: (_: unknown, record: RowData) => (
        <Space>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => {
              setEditingProcess(record);
              processForm.setFieldsValue(record);
              setProcessModalOpen(true);
            }}
          />
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => deleteProcess(record)} />
        </Space>
      ),
    },
  ];

  const stepColumns = [
    { title: t('Order'), dataIndex: 'stepOrder', width: 80 },
    { title: t('Step'), dataIndex: 'name', ellipsis: true },
    { title: t('Folder'), dataIndex: 'folderPath', ellipsis: true },
    { title: t('Process'), dataIndex: 'processName', ellipsis: true },
    { title: t('Trigger'), dataIndex: 'triggerType', width: 100, render: (value: string) => <Tag>{value}</Tag> },
    { title: t('Queue'), dataIndex: 'queueName', ellipsis: true },
    { title: t('SLA (sec)'), dataIndex: 'slaSeconds', width: 100 },
    {
      title: t('Actions'),
      width: 120,
      render: (_: unknown, record: RowData) => (
        <Space>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => {
              setEditingStep(record);
              stepForm.setFieldsValue(record);
              setStepModalOpen(true);
            }}
          />
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => deleteStep(record)} />
        </Space>
      ),
    },
  ];

  const snapshotSteps = snapshot && Array.isArray(snapshot.steps) ? (snapshot.steps as RowData[]) : [];
  const summary = snapshot && typeof snapshot.summary === 'object' ? (snapshot.summary as RowData) : {};

  return (
    <div>
      <Tabs
        items={[
          {
            key: 'registry',
            label: t('Process Registry'),
            children: (
              <>
                <Space style={{ marginBottom: 16 }} wrap>
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    onClick={() => {
                      setEditingProcess(null);
                      processForm.resetFields();
                      processForm.setFieldsValue({ enabled: true, defaultWindowMinutes: 1440 });
                      setProcessModalOpen(true);
                    }}
                  >
                    {t('Add Process')}
                  </Button>
                  <Button icon={<ReloadOutlined />} onClick={() => refreshProcesses()}>
                    {t('Refresh')}
                  </Button>
                </Space>
                <Table
                  dataSource={processes}
                  columns={processColumns}
                  rowKey="id"
                  loading={processesLoading}
                  size="small"
                  rowClassName={(record) => (rowId(record) === selectedProcessId ? 'ant-table-row-selected' : '')}
                  onRow={(record) => ({ onClick: () => setSelectedProcessId(rowId(record)) })}
                  pagination={{ pageSize: 10 }}
                />

                <Space style={{ margin: '16px 0' }} wrap>
                  <Button
                    icon={<PlusOutlined />}
                    disabled={!selectedProcessId}
                    onClick={() => {
                      setEditingStep(null);
                      stepForm.resetFields();
                      stepForm.setFieldsValue({
                        enabled: true,
                        triggerType: 'direct',
                        stepOrder: steps.length + 1,
                        folderId,
                      });
                      setStepModalOpen(true);
                    }}
                  >
                    {t('Add Step')}
                  </Button>
                  <Button icon={<ReloadOutlined />} disabled={!selectedProcessId} onClick={() => refreshSteps()}>
                    {t('Refresh Steps')}
                  </Button>
                </Space>
                <Table
                  dataSource={steps}
                  columns={stepColumns}
                  rowKey="id"
                  loading={stepsLoading}
                  size="small"
                  pagination={false}
                />
              </>
            ),
          },
          {
            key: 'monitor',
            label: t('Monitor'),
            children: (
              <>
                <Space style={{ marginBottom: 16 }} wrap>
                  <Select
                    placeholder={t('Select process')}
                    style={{ width: 320 }}
                    value={selectedProcessId}
                    onChange={setSelectedProcessId}
                    options={processes.map((process) => ({
                      label: `${textValue(process.code) || rowId(process)} - ${textValue(process.name)}`,
                      value: rowId(process),
                    }))}
                  />
                  <Button type="primary" icon={<SearchOutlined />} loading={snapshotLoading} onClick={loadSnapshot}>
                    {t('Load Snapshot')}
                  </Button>
                </Space>
                {!selectedProcess ? (
                  <Empty description={t('Select a process to monitor')} />
                ) : snapshot ? (
                  <>
                    <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
                      <Col xs={12} md={4}>
                        <Statistic title={t('Steps')} value={Number(summary.steps) || 0} />
                      </Col>
                      <Col xs={12} md={4}>
                        <Statistic title={t('Jobs')} value={Number(summary.jobs) || 0} />
                      </Col>
                      <Col xs={12} md={4}>
                        <Statistic title={t('Queues')} value={Number(summary.queues) || 0} />
                      </Col>
                      <Col xs={12} md={4}>
                        <Statistic title={t('Logs')} value={Number(summary.logs) || 0} />
                      </Col>
                      <Col xs={12} md={4}>
                        <Statistic title={t('Faulted Steps')} value={Number(summary.faultedSteps) || 0} />
                      </Col>
                      <Col xs={12} md={4}>
                        <Statistic title={t('SLA Breaches')} value={Number(summary.slaBreaches) || 0} />
                      </Col>
                    </Row>
                    <Table
                      dataSource={snapshotSteps}
                      rowKey={(record) => String((record.step as RowData)?.id || (record.step as RowData)?.name)}
                      size="small"
                      pagination={false}
                      columns={[
                        {
                          title: t('Step'),
                          render: (_: unknown, record: RowData) => textValue((record.step as RowData)?.name),
                        },
                        {
                          title: t('Status'),
                          dataIndex: 'status',
                          width: 110,
                          render: (value: string) => <Tag color={statusColors[value] || 'default'}>{value}</Tag>,
                        },
                        {
                          title: t('Jobs'),
                          render: (_: unknown, record: RowData) => Number((record.counts as RowData)?.jobs) || 0,
                        },
                        {
                          title: t('Queues'),
                          render: (_: unknown, record: RowData) => Number((record.counts as RowData)?.queues) || 0,
                        },
                        {
                          title: t('Logs'),
                          render: (_: unknown, record: RowData) => Number((record.counts as RowData)?.logs) || 0,
                        },
                        {
                          title: t('SLA Breaches'),
                          render: (_: unknown, record: RowData) => Number((record.counts as RowData)?.slaBreaches) || 0,
                        },
                      ]}
                      expandable={{
                        expandedRowRender: (record) => (
                          <Tabs
                            size="small"
                            items={[
                              {
                                key: 'jobs',
                                label: t('Jobs'),
                                children: (
                                  <Table
                                    dataSource={(record.jobs as RowData[]) || []}
                                    rowKey="Id"
                                    size="small"
                                    pagination={false}
                                    columns={[
                                      { title: t('Process'), dataIndex: 'ReleaseName', ellipsis: true },
                                      { title: t('State'), dataIndex: 'State', width: 120 },
                                      { title: t('Machine'), dataIndex: 'HostMachineName', ellipsis: true },
                                      {
                                        title: t('Actions'),
                                        width: 100,
                                        render: (_: unknown, row: RowData) => (
                                          <Button size="small" onClick={() => openCorrelation('job', row)}>
                                            {t('Trace')}
                                          </Button>
                                        ),
                                      },
                                    ]}
                                  />
                                ),
                              },
                              {
                                key: 'queues',
                                label: t('Queues'),
                                children: (
                                  <Table
                                    dataSource={(record.queueItems as RowData[]) || []}
                                    rowKey="Id"
                                    size="small"
                                    pagination={false}
                                    columns={[
                                      { title: t('Reference'), dataIndex: 'Reference', ellipsis: true },
                                      { title: t('Status'), dataIndex: 'Status', width: 120 },
                                      { title: t('Priority'), dataIndex: 'Priority', width: 100 },
                                      {
                                        title: t('Actions'),
                                        width: 100,
                                        render: (_: unknown, row: RowData) => (
                                          <Button size="small" onClick={() => openCorrelation('queue', row)}>
                                            {t('Trace')}
                                          </Button>
                                        ),
                                      },
                                    ]}
                                  />
                                ),
                              },
                              {
                                key: 'logs',
                                label: t('Logs'),
                                children: (
                                  <Table
                                    dataSource={(record.logs as RowData[]) || []}
                                    rowKey="Id"
                                    size="small"
                                    pagination={{ pageSize: 10 }}
                                    columns={[
                                      { title: t('Time'), dataIndex: 'TimeStamp', width: 180 },
                                      { title: t('Level'), dataIndex: 'Level', width: 100 },
                                      { title: t('Message'), dataIndex: 'Message', ellipsis: true },
                                      {
                                        title: t('Actions'),
                                        width: 100,
                                        render: (_: unknown, row: RowData) => (
                                          <Button size="small" onClick={() => openCorrelation('log', row)}>
                                            {t('Trace')}
                                          </Button>
                                        ),
                                      },
                                    ]}
                                  />
                                ),
                              },
                            ]}
                          />
                        ),
                      }}
                    />
                  </>
                ) : (
                  <Alert type="info" showIcon message={t('Load a snapshot to view process health')} />
                )}
              </>
            ),
          },
        ]}
      />

      <Modal
        title={editingProcess ? t('Edit Process') : t('New Process')}
        open={processModalOpen}
        onOk={saveProcess}
        onCancel={() => setProcessModalOpen(false)}
        width={640}
      >
        <Form form={processForm} layout="vertical">
          <Form.Item name="code" label={t('Code')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label={t('Description')}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="owner" label={t('Owner')}>
            <Input />
          </Form.Item>
          <Form.Item name="defaultWindowMinutes" label={t('Default window minutes')}>
            <InputNumber min={5} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={editingStep ? t('Edit Step') : t('New Step')}
        open={stepModalOpen}
        onOk={saveStep}
        onCancel={() => setStepModalOpen(false)}
        width={720}
      >
        <Form form={stepForm} layout="vertical">
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="stepOrder" label={t('Order')} rules={[{ required: true }]}>
                <InputNumber min={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item name="name" label={t('Step name')} rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="folderId" label={t('Folder')}>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              options={folders.map((folder) => ({
                label: folder.fullyQualifiedName || folder.displayName,
                value: folder.folderId,
              }))}
            />
          </Form.Item>
          <Form.Item name="releaseId" label={t('Process / release')}>
            <Select allowClear showSearch loading={releasesLoading} optionFilterProp="label" options={releaseOptions} />
          </Form.Item>
          {releasesError ? (
            <Alert
              type="warning"
              showIcon
              message={t('Process / release')}
              description={releasesError.message}
              style={{ marginBottom: 16 }}
            />
          ) : null}
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="triggerType" label={t('Trigger')}>
                <Select
                  options={triggerTypeOptions}
                  onChange={(value) => {
                    stepForm.setFieldsValue({
                      triggerType: value,
                      scheduleName: undefined,
                      queueDefinitionId: value === 'direct' ? undefined : stepForm.getFieldValue('queueDefinitionId'),
                    });
                  }}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              {stepTriggerType === 'direct' ? (
                <Form.Item name="scheduleName" label={t('Trigger selection')}>
                  <Input disabled />
                </Form.Item>
              ) : (
                <Form.Item
                  name="scheduleName"
                  label={stepTriggerType === 'queue' ? t('Queue trigger') : t('Schedule trigger')}
                >
                  <Select
                    allowClear
                    showSearch
                    loading={schedulesLoading}
                    optionFilterProp="label"
                    options={triggerOptions}
                    onChange={applyTriggerSelection}
                  />
                </Form.Item>
              )}
            </Col>
          </Row>
          {schedulesError ? (
            <Alert
              type="warning"
              showIcon
              message={t('Trigger selection')}
              description={schedulesError.message}
              style={{ marginBottom: 16 }}
            />
          ) : null}
          <Form.Item name="queueDefinitionId" label={t('Queue')}>
            <Select allowClear showSearch loading={queuesLoading} optionFilterProp="label" options={queueOptions} />
          </Form.Item>
          <Form.Item name="referencePattern" label={t('Reference pattern')}>
            <Input />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="expectedDurationSeconds" label={t('Expected duration seconds')}>
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="slaSeconds" label={t('SLA seconds')}>
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={correlation?.title}
        open={Boolean(correlation)}
        onClose={() => setCorrelation(null)}
        width={720}
        loading={correlation?.loading}
      >
        {correlation?.data?.error ? (
          <Alert type="error" showIcon message={t('Failed')} description={String(correlation.data.error)} />
        ) : correlation?.data ? (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label={t('Jobs')}>
              {JSON.stringify(correlation.data.jobs || correlation.data.job || [], null, 2)}
            </Descriptions.Item>
            <Descriptions.Item label={t('Queues')}>
              {JSON.stringify(correlation.data.queueItems || correlation.data.queueItem || [], null, 2)}
            </Descriptions.Item>
            <Descriptions.Item label={t('Logs')}>
              {JSON.stringify(correlation.data.logs || correlation.data.nearbyLogs || [], null, 2)}
            </Descriptions.Item>
          </Descriptions>
        ) : null}
      </Drawer>
    </div>
  );
};
