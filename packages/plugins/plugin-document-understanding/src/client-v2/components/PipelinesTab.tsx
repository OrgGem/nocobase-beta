import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Switch,
  message,
  Select,
  InputNumber,
  Card,
  Space,
  Tag,
  Popconfirm,
  Collapse,
  Tooltip,
  Empty,
  Badge,
  Alert,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  ThunderboltOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useFlowContext } from '@nocobase/flow-engine';
import { useT } from '../locale';
import { EndpointDef, JobState, PipelineDef, PipelineStepDef, errorMessage, unwrapData } from '../types';

const { TextArea } = Input;
const { Panel } = Collapse;

const STATUS_COLORS: Record<string, string> = {
  pending: 'default',
  running: 'processing',
  polling: 'processing',
  completed: 'success',
  failed: 'error',
  timeout: 'error',
};

const TERMINAL_STATUSES = ['completed', 'failed', 'timeout'];

interface JsonSchemaNode {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  default?: unknown;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const stringifyJson = (value: unknown) => JSON.stringify(value ?? {}, null, 2);

const buildDefaultInputFromSchema = (schema: unknown): unknown => {
  if (!isPlainObject(schema)) {
    return {};
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'default')) {
    return schema.default;
  }

  const node = schema as JsonSchemaNode;

  if (node.type === 'object' || node.properties) {
    return Object.entries(node.properties || {}).reduce<Record<string, unknown>>((acc, [key, propertySchema]) => {
      const value = buildDefaultInputFromSchema(propertySchema);
      if (value !== undefined) {
        acc[key] = value;
      }
      return acc;
    }, {});
  }

  if (node.type === 'array') {
    return [];
  }

  return undefined;
};

const mergeDefaults = (defaults: unknown, value: unknown): unknown => {
  if (isPlainObject(defaults) && isPlainObject(value)) {
    return Object.entries(defaults).reduce<Record<string, unknown>>(
      (acc, [key, defaultValue]) => ({
        ...acc,
        [key]: mergeDefaults(defaultValue, acc[key]),
      }),
      { ...value },
    );
  }

  return value === undefined ? defaults : value;
};

/* ─── JSON Editor ───────────────────────────────────────────────── */
const JsonEditor: React.FC<{
  value?: unknown;
  onChange?: (v: unknown) => void;
  placeholder?: string;
  rows?: number;
}> = ({ value, onChange, placeholder, rows = 5 }) => {
  const t = useT();
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!value) {
      setText('');
      return;
    }
    try {
      setText(typeof value === 'string' ? JSON.stringify(JSON.parse(value), null, 2) : JSON.stringify(value, null, 2));
    } catch {
      setText(typeof value === 'string' ? value : '');
    }
  }, [value]);

  const handleBlur = () => {
    if (!text.trim()) {
      setError('');
      onChange?.(null);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      setError('');
      onChange?.(parsed);
    } catch {
      setError(t('Invalid JSON'));
    }
  };

  return (
    <div>
      <TextArea
        rows={rows}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={handleBlur}
        placeholder={placeholder || '{}'}
        status={error ? 'error' : undefined}
        style={{ fontFamily: 'monospace', fontSize: 12 }}
      />
      {error && (
        <div role="alert" style={{ color: '#ff4d4f', fontSize: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
};

/* ─── Step Editor ───────────────────────────────────────────────── */
type StepErrorMode = 'fail' | 'skip' | 'retry';

interface StepData {
  _key: string; // client-side key for React
  id?: number;
  stepOrder: number;
  name: string;
  endpointId: number | null;
  inputMapping: Record<string, unknown> | null;
  outputAlias: string;
  condition: unknown;
  onError: StepErrorMode;
  retryCount: number;
}

const emptyStep = (order: number): StepData => ({
  _key: `new_${Date.now()}_${Math.random()}`,
  stepOrder: order,
  name: '',
  endpointId: null,
  inputMapping: null,
  outputAlias: '',
  condition: null,
  onError: 'fail',
  retryCount: 0,
});

const StepEditor: React.FC<{
  steps: StepData[];
  endpoints: EndpointDef[];
  onChange: (steps: StepData[]) => void;
}> = ({ steps, endpoints, onChange }) => {
  const t = useT();

  const moveStep = (index: number, direction: -1 | 1) => {
    const newSteps = [...steps];
    const target = index + direction;
    if (target < 0 || target >= newSteps.length) return;
    [newSteps[index], newSteps[target]] = [newSteps[target], newSteps[index]];
    // Recompute stepOrder
    newSteps.forEach((s, i) => (s.stepOrder = i + 1));
    onChange(newSteps);
  };

  const updateStep = <K extends keyof StepData>(index: number, field: K, value: StepData[K]) => {
    const newSteps = [...steps];
    newSteps[index] = { ...newSteps[index], [field]: value };
    onChange(newSteps);
  };

  const removeStep = (index: number) => {
    const newSteps = steps.filter((_, i) => i !== index);
    newSteps.forEach((s, i) => (s.stepOrder = i + 1));
    onChange(newSteps);
  };

  const addStep = () => {
    onChange([...steps, emptyStep(steps.length + 1)]);
  };

  if (steps.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '20px 0' }}>
        <Empty description={t('No steps yet')} imageStyle={{ height: 40 }} />
        <Button type="dashed" icon={<PlusOutlined />} onClick={addStep} style={{ marginTop: 8 }}>
          {t('Add First Step')}
        </Button>
      </div>
    );
  }

  return (
    <div>
      <Collapse size="small" defaultActiveKey={steps.map((s) => s._key)}>
        {steps.map((step, index) => {
          const ep = endpoints.find((e) => e.id === step.endpointId);
          const headerExtra = (
            <Space size={4} onClick={(e) => e.stopPropagation()}>
              <Button
                size="small"
                disabled={index === 0}
                icon={<ArrowUpOutlined />}
                onClick={() => moveStep(index, -1)}
                aria-label={t('Move step up')}
              />
              <Button
                size="small"
                disabled={index === steps.length - 1}
                icon={<ArrowDownOutlined />}
                onClick={() => moveStep(index, 1)}
                aria-label={t('Move step down')}
              />
              <Popconfirm title={t('Remove step?')} okText={t('Delete')} onConfirm={() => removeStep(index)}>
                <Button size="small" danger icon={<DeleteOutlined />} aria-label={t('Remove step?')} />
              </Popconfirm>
            </Space>
          );

          const label = (
            <Space>
              <Badge count={step.stepOrder} style={{ backgroundColor: '#1677ff' }} />
              <span>{step.name || t('(unnamed)')}</span>
              {ep && <Tag>{ep.name}</Tag>}
              {step.onError === 'skip' && (
                <Tooltip title={t('Step can be skipped on error')}>
                  <Tag color="orange">{t('skip on error')}</Tag>
                </Tooltip>
              )}
              {step.condition && (
                <Tooltip title={t('Has condition')}>
                  <Tag color="purple">{t('conditional')}</Tag>
                </Tooltip>
              )}
            </Space>
          );

          const nameId = `step-name-${step._key}`;
          const endpointId = `step-endpoint-${step._key}`;
          const aliasId = `step-alias-${step._key}`;

          return (
            <Panel key={step._key} header={label} extra={headerExtra}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
                <div>
                  <label htmlFor={nameId} style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>
                    {t('Step Name')} *
                  </label>
                  <Input
                    id={nameId}
                    value={step.name}
                    onChange={(e) => updateStep(index, 'name', e.target.value)}
                    placeholder="OCR, Classify, Extract..."
                  />
                </div>
                <div>
                  <label htmlFor={endpointId} style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>
                    {t('Endpoint')} *
                  </label>
                  <Select
                    id={endpointId}
                    value={step.endpointId}
                    onChange={(v) => updateStep(index, 'endpointId', v)}
                    placeholder={t('Select endpoint')}
                    style={{ width: '100%' }}
                    options={endpoints.map((endpoint) => ({
                      value: endpoint.id,
                      label: `${endpoint.name} (${endpoint.method} ${endpoint.subpath})`,
                    }))}
                  />
                </div>
                <div>
                  <label
                    htmlFor={aliasId}
                    style={{ fontWeight: 500, display: 'block', marginBottom: 4, marginTop: 12 }}
                  >
                    {t('Output Alias')}
                  </label>
                  <Input
                    id={aliasId}
                    value={step.outputAlias}
                    onChange={(e) => updateStep(index, 'outputAlias', e.target.value)}
                    placeholder="ocr_result"
                  />
                  <div style={{ color: '#888', fontSize: 11 }}>
                    {t('Other steps reference this as')}: $step[{step.outputAlias || step.stepOrder}].response.field
                  </div>
                </div>
                <div>
                  <label style={{ fontWeight: 500, display: 'block', marginBottom: 4, marginTop: 12 }}>
                    {t('On Error')}
                  </label>
                  <Space>
                    <Select
                      value={step.onError}
                      onChange={(v: StepErrorMode) => updateStep(index, 'onError', v)}
                      style={{ width: 120 }}
                      aria-label={t('On Error')}
                      options={[
                        { value: 'fail', label: t('Fail') },
                        { value: 'skip', label: t('Skip') },
                        { value: 'retry', label: t('Retry') },
                      ]}
                    />
                    {step.onError === 'retry' && (
                      <InputNumber
                        value={step.retryCount}
                        onChange={(v) => updateStep(index, 'retryCount', v || 0)}
                        min={1}
                        max={10}
                        addonBefore="x"
                        style={{ width: 100 }}
                        aria-label={t('Retry')}
                      />
                    )}
                  </Space>
                </div>
              </div>

              <div style={{ marginTop: 12 }}>
                <label style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>
                  {t('Input Mapping (JSON)')}
                  <Tooltip
                    title={t(
                      'Map endpoint input fields. Use $input.field, $step[alias].response.field, $files, or literal values.',
                    )}
                  >
                    <span style={{ fontWeight: 'normal', color: '#888', marginLeft: 6, cursor: 'help' }}>?</span>
                  </Tooltip>
                </label>
                <JsonEditor
                  value={step.inputMapping}
                  onChange={(v) => updateStep(index, 'inputMapping', v as Record<string, unknown> | null)}
                  placeholder='{ "text": "$step[ocr_result].response.text", "lang": "vi" }'
                  rows={3}
                />
              </div>

              <div style={{ marginTop: 12 }}>
                <label style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>
                  {t('Condition (optional JSON)')}
                  <Tooltip title={t('Only run this step if the condition matches.')}>
                    <span style={{ fontWeight: 'normal', color: '#888', marginLeft: 6, cursor: 'help' }}>?</span>
                  </Tooltip>
                </label>
                <JsonEditor
                  value={step.condition}
                  onChange={(v) => updateStep(index, 'condition', v)}
                  placeholder='{ "field": "$step[classify].response.type", "op": "eq", "value": "invoice" }'
                  rows={2}
                />
              </div>
            </Panel>
          );
        })}
      </Collapse>
      <Button type="dashed" icon={<PlusOutlined />} onClick={addStep} style={{ marginTop: 8, width: '100%' }}>
        {t('Add Step')}
      </Button>
    </div>
  );
};

/* ─── Pipelines Tab ─────────────────────────────────────────────── */
interface PipelineFormValues {
  name: string;
  description?: string;
  enabled: boolean;
  inputSchema?: unknown;
  outputMapping?: Record<string, unknown> | null;
}

export const PipelinesTab = () => {
  const ctx = useFlowContext();
  const api = ctx.api;
  const t = useT();
  const [pipelines, setPipelines] = useState<PipelineDef[]>([]);
  const [endpoints, setEndpoints] = useState<EndpointDef[]>([]);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(false);
  const [form] = Form.useForm<PipelineFormValues>();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [steps, setSteps] = useState<StepData[]>([]);
  const [playgroundVisible, setPlaygroundVisible] = useState(false);
  const [playgroundPipeline, setPlaygroundPipeline] = useState<PipelineDef | null>(null);
  const [playgroundInput, setPlaygroundInput] = useState('{}');
  const [playgroundInputError, setPlaygroundInputError] = useState('');
  const [playgroundJob, setPlaygroundJob] = useState<JobState | null>(null);
  const [playgroundRunning, setPlaygroundRunning] = useState(false);
  const playgroundTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const statusLabels: Record<string, string> = {
    pending: t('Pending'),
    running: t('Running'),
    polling: t('Polling'),
    completed: t('Completed'),
    failed: t('Failed'),
    timeout: t('Timeout'),
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [pRes, eRes] = await Promise.all([
        api.request({ url: 'docUnderstanding:listPipelines' }),
        api.request({ url: 'docUnderstanding:listEndpoints' }),
      ]);
      setPipelines(unwrapData<PipelineDef[]>(pRes, []));
      setEndpoints(unwrapData<EndpointDef[]>(eRes, []));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    return () => {
      if (playgroundTimerRef.current) {
        clearInterval(playgroundTimerRef.current);
      }
    };
  }, []);

  const openAdd = () => {
    setEditingId(null);
    form.resetFields();
    setSteps([]);
    setVisible(true);
  };

  const openEdit = (record: PipelineDef) => {
    setEditingId(record.id);
    form.setFieldsValue({
      name: record.name,
      description: record.description,
      enabled: record.enabled,
      inputSchema: record.inputSchema,
      outputMapping: record.outputMapping,
    });
    // Convert steps from server format
    const serverSteps = [...(record.steps || [])].sort((a, b) => a.stepOrder - b.stepOrder);
    setSteps(
      serverSteps.map((s) => ({
        _key: `srv_${s.id}`,
        id: s.id,
        stepOrder: s.stepOrder,
        name: s.name,
        endpointId: s.endpointId,
        inputMapping: s.inputMapping ?? null,
        outputAlias: s.outputAlias || '',
        condition: s.condition,
        onError: s.onError || 'fail',
        retryCount: s.retryCount || 0,
      })),
    );
    setVisible(true);
  };

  const handleDelete = async (id: number) => {
    await api.request({
      url: 'docUnderstanding:deletePipeline',
      method: 'POST',
      params: { filterByTk: id },
    });
    message.success(t('Deleted'));
    fetchData();
  };

  const stopPlaygroundPolling = useCallback(() => {
    if (playgroundTimerRef.current) {
      clearInterval(playgroundTimerRef.current);
      playgroundTimerRef.current = null;
    }
  }, []);

  const fetchPlaygroundJob = useCallback(
    async (jobId: number) => {
      const res = await api.request({
        url: 'docUnderstanding:getJobStatus',
        params: { filterByTk: jobId },
      });
      const job = unwrapData<JobState | null>(res, null);
      setPlaygroundJob(job);

      if (job && TERMINAL_STATUSES.includes(job.status)) {
        stopPlaygroundPolling();
        setPlaygroundRunning(false);
      }
      return job;
    },
    [api, stopPlaygroundPolling],
  );

  const startPlaygroundPolling = useCallback(
    (jobId: number) => {
      stopPlaygroundPolling();
      playgroundTimerRef.current = setInterval(() => {
        fetchPlaygroundJob(jobId).catch((err: unknown) => {
          stopPlaygroundPolling();
          setPlaygroundRunning(false);
          message.error(errorMessage(err) || t('Failed to refresh test job'));
        });
      }, 1500);
    },
    [fetchPlaygroundJob, stopPlaygroundPolling, t],
  );

  const openPlayground = (record: PipelineDef) => {
    stopPlaygroundPolling();
    setPlaygroundPipeline(record);
    setPlaygroundJob(null);
    setPlaygroundRunning(false);
    setPlaygroundInputError('');
    setPlaygroundInput(stringifyJson(buildDefaultInputFromSchema(record.inputSchema)));
    setPlaygroundVisible(true);
  };

  const closePlayground = () => {
    stopPlaygroundPolling();
    setPlaygroundVisible(false);
    setPlaygroundPipeline(null);
    setPlaygroundJob(null);
    setPlaygroundRunning(false);
  };

  const runPlayground = async () => {
    if (!playgroundPipeline) return;

    let input: unknown;
    try {
      const parsedInput = playgroundInput.trim() ? JSON.parse(playgroundInput) : {};
      input = mergeDefaults(buildDefaultInputFromSchema(playgroundPipeline.inputSchema), parsedInput);
      setPlaygroundInputError('');
    } catch {
      setPlaygroundInputError(t('Invalid JSON input'));
      return;
    }

    stopPlaygroundPolling();
    setPlaygroundRunning(true);
    setPlaygroundJob(null);

    try {
      const res = await api.request({
        url: 'docUnderstanding:executePipeline',
        method: 'POST',
        data: {
          pipelineId: playgroundPipeline.id,
          input,
        },
      });
      const jobId = unwrapData<{ jobId?: number }>(res, {}).jobId;
      if (!jobId) {
        throw new Error(t('Pipeline did not return a job ID'));
      }

      const job = await fetchPlaygroundJob(jobId);
      if (!job || !TERMINAL_STATUSES.includes(job.status)) {
        startPlaygroundPolling(jobId);
      }
      message.success(`${t('Test job started')}: #${jobId}`);
    } catch (err: unknown) {
      setPlaygroundRunning(false);
      message.error(errorMessage(err) || t('Failed to run pipeline test'));
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();

      // Validate steps
      for (const step of steps) {
        if (!step.name) {
          message.error(t('All steps must have a name'));
          return;
        }
        if (!step.endpointId) {
          message.error(`${t('Step')} "${step.name || step.stepOrder}" ${t('must have an endpoint')}`);
          return;
        }
      }

      // Check alias uniqueness
      const aliases = steps.map((s) => s.outputAlias).filter(Boolean);
      if (new Set(aliases).size !== aliases.length) {
        message.error(t('Step output aliases must be unique'));
        return;
      }

      const payload = {
        ...values,
        steps: steps.map((s) => ({
          ...(s.id ? { id: s.id } : {}),
          stepOrder: s.stepOrder,
          name: s.name,
          endpointId: s.endpointId,
          inputMapping: s.inputMapping,
          outputAlias: s.outputAlias || undefined,
          condition: s.condition,
          onError: s.onError,
          retryCount: s.onError === 'retry' ? s.retryCount : 0,
        })),
      };

      if (editingId) {
        await api.request({
          url: 'docUnderstanding:updatePipeline',
          method: 'POST',
          params: { filterByTk: editingId },
          data: payload,
        });
      } else {
        await api.request({
          url: 'docUnderstanding:createPipeline',
          method: 'POST',
          data: payload,
        });
      }
      message.success(t('Saved'));
      setVisible(false);
      fetchData();
    } catch {
      // Form validation errors are already surfaced inline by antd.
    }
  };

  const columns: ColumnsType<PipelineDef> = [
    { title: t('Name'), dataIndex: 'name', width: 200 },
    {
      title: t('Steps'),
      dataIndex: 'steps',
      width: 300,
      render: (stepsArr: PipelineStepDef[]) => {
        if (!stepsArr || stepsArr.length === 0) return <Tag>0 {t('steps')}</Tag>;
        const sorted = [...stepsArr].sort((a, b) => a.stepOrder - b.stepOrder);
        return (
          <Space size={2} wrap>
            {sorted.map((s, i) => (
              <React.Fragment key={s.id}>
                {i > 0 && <span style={{ color: '#ccc' }}>&rarr;</span>}
                <Tag>{s.name || `${t('Step')} ${s.stepOrder}`}</Tag>
              </React.Fragment>
            ))}
          </Space>
        );
      },
    },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      width: 80,
      render: (v: boolean) => (v ? <Tag color="success">{t('Yes')}</Tag> : <Tag>{t('No')}</Tag>),
    },
    {
      title: t('AI Tool'),
      width: 100,
      render: (_: unknown, record) =>
        record.enabled ? (
          <Tooltip
            title={`${t('Registered as')}: doc_understanding.${record.name?.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`}
          >
            <Tag color="blue" icon={<ThunderboltOutlined />}>
              {t('Active')}
            </Tag>
          </Tooltip>
        ) : (
          <Tag>{t('Inactive')}</Tag>
        ),
    },
    {
      title: t('Action'),
      width: 190,
      render: (_: unknown, record) => (
        <Space>
          <Button
            type="link"
            size="small"
            icon={<PlayCircleOutlined />}
            disabled={!record.enabled}
            onClick={() => openPlayground(record)}
            aria-label={`${t('Test')} ${record.name}`}
          >
            {t('Test')}
          </Button>
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => openEdit(record)}
            aria-label={`${t('Edit')} ${record.name}`}
          >
            {t('Edit')}
          </Button>
          <Popconfirm title={t('Delete this pipeline?')} okText={t('Delete')} onConfirm={() => handleDelete(record.id)}>
            <Button
              type="link"
              size="small"
              danger
              icon={<DeleteOutlined />}
              aria-label={`${t('Delete')} ${record.name}`}
            >
              {t('Delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>
          {t('Add Pipeline')}
        </Button>
      </div>
      <Table rowKey="id" columns={columns} dataSource={pipelines} loading={loading} size="small" />

      <Modal
        title={editingId ? t('Edit Pipeline') : t('New Pipeline')}
        open={visible}
        onOk={handleSave}
        onCancel={() => setVisible(false)}
        okText={t('Save')}
        cancelText={t('Cancel')}
        width={800}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <Form.Item name="name" label={t('Pipeline Name')} rules={[{ required: true }]}>
              <Input placeholder="full_document_processing" />
            </Form.Item>
            <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked" initialValue={true}>
              <Switch />
            </Form.Item>
          </div>
          <Form.Item name="description" label={t('Description')}>
            <TextArea rows={2} placeholder={t('What this pipeline does')} />
          </Form.Item>

          <Card
            title={t('Pipeline Steps')}
            size="small"
            style={{ marginBottom: 16 }}
            extra={
              <Tag color="blue">
                {steps.length} {t('step(s)')}
              </Tag>
            }
          >
            <StepEditor steps={steps} endpoints={endpoints} onChange={setSteps} />
          </Card>

          <Collapse size="small" ghost>
            <Panel header={t('Advanced: Input Schema & Output Mapping')} key="advanced">
              <Form.Item
                name="inputSchema"
                label={t('Input Schema (JSON Schema)')}
                help={t('Defines what input this pipeline accepts. Used by AI tool schema.')}
              >
                <JsonEditor placeholder='{ "type": "object", "properties": { "document_url": { "type": "string" } }, "required": ["document_url"] }' />
              </Form.Item>
              <Form.Item
                name="outputMapping"
                label={t('Output Mapping (JSON)')}
                help={t('Map final step results to pipeline output. If empty, all step results are returned.')}
              >
                <JsonEditor placeholder='{ "text": "$step[ocr_result].response.text", "category": "$step[classify].response.category" }' />
              </Form.Item>
            </Panel>
          </Collapse>
        </Form>
      </Modal>

      <Modal
        title={playgroundPipeline ? `${t('Test Playground')}: ${playgroundPipeline.name}` : t('Test Playground')}
        open={playgroundVisible}
        onCancel={closePlayground}
        width={860}
        destroyOnClose
        footer={[
          <Button key="close" onClick={closePlayground}>
            {t('Close')}
          </Button>,
          playgroundJob?.id && (
            <Button
              key="refresh"
              icon={<ReloadOutlined />}
              disabled={playgroundRunning}
              onClick={() => fetchPlaygroundJob(playgroundJob.id)}
            >
              {t('Refresh')}
            </Button>
          ),
          <Button
            key="run"
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={playgroundRunning}
            onClick={runPlayground}
          >
            {t('Run test')}
          </Button>,
        ].filter(Boolean)}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
          <div>
            <label htmlFor="playground-input" style={{ fontWeight: 500, marginBottom: 6, display: 'block' }}>
              {t('Input JSON')}
            </label>
            <TextArea
              id="playground-input"
              rows={16}
              value={playgroundInput}
              onChange={(e) => {
                setPlaygroundInput(e.target.value);
                if (playgroundInputError) setPlaygroundInputError('');
              }}
              placeholder='{ "document_url": "https://..." }'
              status={playgroundInputError ? 'error' : undefined}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
            />
            {playgroundInputError && (
              <Alert type="error" showIcon message={playgroundInputError} style={{ marginTop: 8 }} />
            )}

            <Collapse size="small" ghost style={{ marginTop: 12 }}>
              <Panel header={t('Input Schema')} key="schema">
                <pre
                  style={{
                    background: '#f5f5f5',
                    padding: 12,
                    borderRadius: 6,
                    fontSize: 12,
                    maxHeight: 220,
                    overflow: 'auto',
                  }}
                >
                  {stringifyJson(playgroundPipeline?.inputSchema)}
                </pre>
              </Panel>
            </Collapse>
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontWeight: 500 }}>{t('Result')}</span>
              {playgroundJob?.status && (
                <Tag color={STATUS_COLORS[playgroundJob.status] || 'default'}>
                  {statusLabels[playgroundJob.status] || playgroundJob.status}
                </Tag>
              )}
            </div>

            {!playgroundJob ? (
              <Empty description={t('Run a test to see job output')} imageStyle={{ height: 48 }} />
            ) : (
              <div>
                <Space style={{ marginBottom: 8 }} wrap>
                  <Tag>
                    {t('Job')} #{playgroundJob.id}
                  </Tag>
                  {playgroundJob.currentStep && (
                    <Tag>
                      {t('Step')} {playgroundJob.currentStep}
                    </Tag>
                  )}
                </Space>

                {playgroundJob.error && (
                  <Alert
                    type="error"
                    showIcon
                    message={t('Pipeline error')}
                    description={<pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{playgroundJob.error}</pre>}
                    style={{ marginBottom: 12 }}
                  />
                )}

                <div style={{ fontWeight: 500, marginBottom: 4 }}>{t('Final Result')}</div>
                <pre
                  style={{
                    background: '#f0f5ff',
                    padding: 12,
                    borderRadius: 6,
                    fontSize: 12,
                    maxHeight: 220,
                    overflow: 'auto',
                  }}
                >
                  {playgroundJob.finalResult !== undefined && playgroundJob.finalResult !== null
                    ? stringifyJson(playgroundJob.finalResult)
                    : t('(not yet available)')}
                </pre>

                <div style={{ fontWeight: 500, margin: '12px 0 4px' }}>{t('Step Results')}</div>
                <pre
                  style={{
                    background: '#f5f5f5',
                    padding: 12,
                    borderRadius: 6,
                    fontSize: 12,
                    maxHeight: 260,
                    overflow: 'auto',
                  }}
                >
                  {playgroundJob.stepResults ? stringifyJson(playgroundJob.stepResults) : '{}'}
                </pre>
              </div>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
};
