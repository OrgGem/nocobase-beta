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
import { useApp } from '@nocobase/client-v2';

const { TextArea } = Input;
const { Panel } = Collapse;

const STATUS_CONFIG: Record<string, { color: string; label: string }> = {
  pending: { color: 'default', label: 'Pending' },
  running: { color: 'processing', label: 'Running' },
  polling: { color: 'processing', label: 'Polling' },
  completed: { color: 'success', label: 'Completed' },
  failed: { color: 'error', label: 'Failed' },
  timeout: { color: 'error', label: 'Timeout' },
};

const extractResponseData = (res: any) => res?.data?.data ?? res?.data ?? res;

const stringifyJson = (value: any) => JSON.stringify(value ?? {}, null, 2);

const buildDefaultInputFromSchema = (schema: any): any => {
  if (!schema || typeof schema !== 'object') {
    return {};
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'default')) {
    return schema.default;
  }

  if (schema.type === 'object' || schema.properties) {
    return Object.entries(schema.properties || {}).reduce<Record<string, any>>((acc, [key, propertySchema]: any) => {
      const value = buildDefaultInputFromSchema(propertySchema);
      if (value !== undefined) {
        acc[key] = value;
      }
      return acc;
    }, {});
  }

  if (schema.type === 'array') {
    return [];
  }

  return undefined;
};

const mergeDefaults = (defaults: any, value: any): any => {
  if (
    defaults &&
    value &&
    typeof defaults === 'object' &&
    typeof value === 'object' &&
    !Array.isArray(defaults) &&
    !Array.isArray(value)
  ) {
    return Object.entries(defaults).reduce(
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
  value?: any;
  onChange?: (v: any) => void;
  placeholder?: string;
  rows?: number;
}> = ({ value, onChange, placeholder, rows = 5 }) => {
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!value) {
      setText('');
      return;
    }
    try {
      setText(typeof value === 'string' ? JSON.stringify(JSON.parse(value), null, 2) : JSON.stringify(value, null, 2));
    } catch (e) {
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
      setError('Invalid JSON');
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
        style={{ fontFamily: 'monospace', fontSize: 12 }}
      />
      {error && <div style={{ color: '#ff4d4f', fontSize: 12 }}>{error}</div>}
    </div>
  );
};

/* ─── Step Editor ───────────────────────────────────────────────── */
interface StepData {
  _key: string; // client-side key for React
  id?: number;
  stepOrder: number;
  name: string;
  endpointId: number | null;
  inputMapping: Record<string, any> | null;
  outputAlias: string;
  condition: any;
  onError: string;
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
  endpoints: any[];
  onChange: (steps: StepData[]) => void;
}> = ({ steps, endpoints, onChange }) => {
  const moveStep = (index: number, direction: -1 | 1) => {
    const newSteps = [...steps];
    const target = index + direction;
    if (target < 0 || target >= newSteps.length) return;
    [newSteps[index], newSteps[target]] = [newSteps[target], newSteps[index]];
    // Recompute stepOrder
    newSteps.forEach((s, i) => (s.stepOrder = i + 1));
    onChange(newSteps);
  };

  const updateStep = (index: number, field: string, value: any) => {
    const newSteps = [...steps];
    (newSteps[index] as any)[field] = value;
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
        <Empty description="No steps yet" imageStyle={{ height: 40 }} />
        <Button type="dashed" icon={<PlusOutlined />} onClick={addStep} style={{ marginTop: 8 }}>
          Add First Step
        </Button>
      </div>
    );
  }

  return (
    <div>
      <Collapse size="small" defaultActiveKey={steps.map((s) => s._key)}>
        {steps.map((step, index) => {
          const ep = endpoints.find((e: any) => e.id === step.endpointId);
          const headerExtra = (
            <Space size={4} onClick={(e) => e.stopPropagation()}>
              <Button
                size="small"
                disabled={index === 0}
                icon={<ArrowUpOutlined />}
                onClick={() => moveStep(index, -1)}
              />
              <Button
                size="small"
                disabled={index === steps.length - 1}
                icon={<ArrowDownOutlined />}
                onClick={() => moveStep(index, 1)}
              />
              <Popconfirm title="Remove step?" onConfirm={() => removeStep(index)}>
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </Space>
          );

          const label = (
            <Space>
              <Badge count={step.stepOrder} style={{ backgroundColor: '#1677ff' }} />
              <span>{step.name || '(unnamed)'}</span>
              {ep && <Tag>{ep.name}</Tag>}
              {step.onError === 'skip' && (
                <Tooltip title="Step can be skipped on error">
                  <Tag color="orange">skip on error</Tag>
                </Tooltip>
              )}
              {step.condition && (
                <Tooltip title="Has condition">
                  <Tag color="purple">conditional</Tag>
                </Tooltip>
              )}
            </Space>
          );

          return (
            <Panel key={step._key} header={label} extra={headerExtra}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
                <div>
                  <label style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>Step Name *</label>
                  <Input
                    value={step.name}
                    onChange={(e) => updateStep(index, 'name', e.target.value)}
                    placeholder="OCR, Classify, Extract..."
                  />
                </div>
                <div>
                  <label style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>Endpoint *</label>
                  <Select
                    value={step.endpointId}
                    onChange={(v) => updateStep(index, 'endpointId', v)}
                    placeholder="Select endpoint"
                    style={{ width: '100%' }}
                    options={endpoints.map((ep: any) => ({
                      value: ep.id,
                      label: `${ep.name} (${ep.method} ${ep.subpath})`,
                    }))}
                  />
                </div>
                <div>
                  <label style={{ fontWeight: 500, display: 'block', marginBottom: 4, marginTop: 12 }}>
                    Output Alias
                  </label>
                  <Input
                    value={step.outputAlias}
                    onChange={(e) => updateStep(index, 'outputAlias', e.target.value)}
                    placeholder="ocr_result"
                  />
                  <div style={{ color: '#888', fontSize: 11 }}>
                    Other steps reference this as: $step[{step.outputAlias || step.stepOrder}].response.field
                  </div>
                </div>
                <div>
                  <label style={{ fontWeight: 500, display: 'block', marginBottom: 4, marginTop: 12 }}>On Error</label>
                  <Space>
                    <Select
                      value={step.onError}
                      onChange={(v) => updateStep(index, 'onError', v)}
                      style={{ width: 120 }}
                    >
                      <Select.Option value="fail">Fail</Select.Option>
                      <Select.Option value="skip">Skip</Select.Option>
                      <Select.Option value="retry">Retry</Select.Option>
                    </Select>
                    {step.onError === 'retry' && (
                      <InputNumber
                        value={step.retryCount}
                        onChange={(v) => updateStep(index, 'retryCount', v || 0)}
                        min={1}
                        max={10}
                        addonBefore="x"
                        style={{ width: 100 }}
                      />
                    )}
                  </Space>
                </div>
              </div>

              <div style={{ marginTop: 12 }}>
                <label style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>
                  Input Mapping (JSON)
                  <Tooltip title="Map endpoint input fields. Use $input.field, $step[alias].response.field, $files, or literal values.">
                    <span style={{ fontWeight: 'normal', color: '#888', marginLeft: 6, cursor: 'help' }}>?</span>
                  </Tooltip>
                </label>
                <JsonEditor
                  value={step.inputMapping}
                  onChange={(v) => updateStep(index, 'inputMapping', v)}
                  placeholder='{ "text": "$step[ocr_result].response.text", "lang": "vi" }'
                  rows={3}
                />
              </div>

              <div style={{ marginTop: 12 }}>
                <label style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>
                  Condition (optional JSON)
                  <Tooltip title='Only run this step if condition matches. Format: { "field": "$step[x].response.y", "op": "eq", "value": "..." }'>
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
        Add Step
      </Button>
    </div>
  );
};

/* ─── Pipelines Tab ─────────────────────────────────────────────── */
export const PipelinesTab = () => {
  const app = useApp();
  const api = app.apiClient;
  const [pipelines, setPipelines] = useState<any[]>([]);
  const [endpoints, setEndpoints] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(false);
  const [form] = Form.useForm();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [steps, setSteps] = useState<StepData[]>([]);
  const [playgroundVisible, setPlaygroundVisible] = useState(false);
  const [playgroundPipeline, setPlaygroundPipeline] = useState<any>(null);
  const [playgroundInput, setPlaygroundInput] = useState('{}');
  const [playgroundInputError, setPlaygroundInputError] = useState('');
  const [playgroundJob, setPlaygroundJob] = useState<any>(null);
  const [playgroundRunning, setPlaygroundRunning] = useState(false);
  const playgroundTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [pRes, eRes] = await Promise.all([
        api.request({ url: 'docUnderstanding:listPipelines' }),
        api.request({ url: 'docUnderstanding:listEndpoints' }),
      ]);
      setPipelines(pRes.data?.data || []);
      setEndpoints(eRes.data?.data || []);
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

  const openEdit = (record: any) => {
    setEditingId(record.id);
    form.setFieldsValue({
      name: record.name,
      description: record.description,
      enabled: record.enabled,
      inputSchema: record.inputSchema,
      outputMapping: record.outputMapping,
    });
    // Convert steps from server format
    const serverSteps = [...(record.steps || [])].sort((a: any, b: any) => a.stepOrder - b.stepOrder);
    setSteps(
      serverSteps.map((s: any) => ({
        _key: `srv_${s.id}`,
        id: s.id,
        stepOrder: s.stepOrder,
        name: s.name,
        endpointId: s.endpointId,
        inputMapping: s.inputMapping,
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
    message.success('Deleted');
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
      const job = extractResponseData(res);
      setPlaygroundJob(job);

      if (['completed', 'failed', 'timeout'].includes(job?.status)) {
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
        fetchPlaygroundJob(jobId).catch((err: any) => {
          stopPlaygroundPolling();
          setPlaygroundRunning(false);
          message.error(err?.message || 'Failed to refresh test job');
        });
      }, 1500);
    },
    [fetchPlaygroundJob, stopPlaygroundPolling],
  );

  const openPlayground = (record: any) => {
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

    let input: any;
    try {
      const parsedInput = playgroundInput.trim() ? JSON.parse(playgroundInput) : {};
      input = mergeDefaults(buildDefaultInputFromSchema(playgroundPipeline.inputSchema), parsedInput);
      setPlaygroundInputError('');
    } catch {
      setPlaygroundInputError('Invalid JSON input');
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
      const result = extractResponseData(res);
      const jobId = result?.jobId;
      if (!jobId) {
        throw new Error('Pipeline did not return a job ID');
      }

      const job = await fetchPlaygroundJob(jobId);
      if (!['completed', 'failed', 'timeout'].includes(job?.status)) {
        startPlaygroundPolling(jobId);
      }
      message.success(`Test job #${jobId} started`);
    } catch (err: any) {
      setPlaygroundRunning(false);
      message.error(err?.message || 'Failed to run pipeline test');
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();

      // Validate steps
      for (const step of steps) {
        if (!step.name) {
          message.error('All steps must have a name');
          return;
        }
        if (!step.endpointId) {
          message.error(`Step "${step.name || step.stepOrder}" must have an endpoint`);
          return;
        }
      }

      // Check alias uniqueness
      const aliases = steps.map((s) => s.outputAlias).filter(Boolean);
      if (new Set(aliases).size !== aliases.length) {
        message.error('Step output aliases must be unique');
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
      message.success('Saved');
      setVisible(false);
      fetchData();
    } catch {
      // form validation error
    }
  };

  const columns = [
    { title: 'Name', dataIndex: 'name', width: 200 },
    {
      title: 'Steps',
      dataIndex: 'steps',
      width: 300,
      render: (stepsArr: any[]) => {
        if (!stepsArr || stepsArr.length === 0) return <Tag>0 steps</Tag>;
        const sorted = [...stepsArr].sort((a: any, b: any) => a.stepOrder - b.stepOrder);
        return (
          <Space size={2} wrap>
            {sorted.map((s: any, i: number) => (
              <React.Fragment key={s.id}>
                {i > 0 && <span style={{ color: '#ccc' }}>&rarr;</span>}
                <Tag>{s.name || `Step ${s.stepOrder}`}</Tag>
              </React.Fragment>
            ))}
          </Space>
        );
      },
    },
    {
      title: 'Enabled',
      dataIndex: 'enabled',
      width: 80,
      render: (v: boolean) => (v ? <Tag color="success">Yes</Tag> : <Tag>No</Tag>),
    },
    {
      title: 'AI Tool',
      width: 100,
      render: (_: any, record: any) =>
        record.enabled ? (
          <Tooltip title={`Registered as: doc_understanding.${record.name?.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`}>
            <Tag color="blue" icon={<ThunderboltOutlined />}>
              Active
            </Tag>
          </Tooltip>
        ) : (
          <Tag>Inactive</Tag>
        ),
    },
    {
      title: 'Action',
      width: 190,
      render: (_: any, record: any) => (
        <Space>
          <Button
            type="link"
            size="small"
            icon={<PlayCircleOutlined />}
            disabled={!record.enabled}
            onClick={() => openPlayground(record)}
          >
            Test
          </Button>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            Edit
          </Button>
          <Popconfirm title="Delete this pipeline?" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              Delete
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
          Add Pipeline
        </Button>
      </div>
      <Table rowKey="id" columns={columns} dataSource={pipelines} loading={loading} size="small" />

      <Modal
        title={editingId ? 'Edit Pipeline' : 'New Pipeline'}
        open={visible}
        onOk={handleSave}
        onCancel={() => setVisible(false)}
        width={800}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <Form.Item name="name" label="Pipeline Name" rules={[{ required: true }]}>
              <Input placeholder="full_document_processing" />
            </Form.Item>
            <Form.Item name="enabled" label="Enabled" valuePropName="checked" initialValue={true}>
              <Switch />
            </Form.Item>
          </div>
          <Form.Item name="description" label="Description">
            <TextArea rows={2} placeholder="What this pipeline does" />
          </Form.Item>

          <Card
            title="Pipeline Steps"
            size="small"
            style={{ marginBottom: 16 }}
            extra={<Tag color="blue">{steps.length} step(s)</Tag>}
          >
            <StepEditor steps={steps} endpoints={endpoints} onChange={setSteps} />
          </Card>

          <Collapse size="small" ghost>
            <Panel header="Advanced: Input Schema & Output Mapping" key="advanced">
              <Form.Item
                name="inputSchema"
                label="Input Schema (JSON Schema)"
                help="Defines what input this pipeline accepts. Used by AI tool schema."
              >
                <JsonEditor placeholder='{ "type": "object", "properties": { "document_url": { "type": "string" } }, "required": ["document_url"] }' />
              </Form.Item>
              <Form.Item
                name="outputMapping"
                label="Output Mapping (JSON)"
                help="Map final step results to pipeline output. If empty, all step results are returned."
              >
                <JsonEditor placeholder='{ "text": "$step[ocr_result].response.text", "category": "$step[classify].response.category" }' />
              </Form.Item>
            </Panel>
          </Collapse>
        </Form>
      </Modal>

      <Modal
        title={playgroundPipeline ? `Test Playground: ${playgroundPipeline.name}` : 'Test Playground'}
        open={playgroundVisible}
        onCancel={closePlayground}
        width={860}
        destroyOnClose
        footer={[
          <Button key="close" onClick={closePlayground}>
            Close
          </Button>,
          playgroundJob?.id && (
            <Button
              key="refresh"
              icon={<ReloadOutlined />}
              disabled={playgroundRunning}
              onClick={() => fetchPlaygroundJob(playgroundJob.id)}
            >
              Refresh
            </Button>
          ),
          <Button
            key="run"
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={playgroundRunning}
            onClick={runPlayground}
          >
            Run test
          </Button>,
        ].filter(Boolean)}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
          <div>
            <div style={{ fontWeight: 500, marginBottom: 6 }}>Input JSON</div>
            <TextArea
              rows={16}
              value={playgroundInput}
              onChange={(e) => {
                setPlaygroundInput(e.target.value);
                if (playgroundInputError) setPlaygroundInputError('');
              }}
              placeholder='{ "document_url": "https://..." }'
              style={{ fontFamily: 'monospace', fontSize: 12 }}
            />
            {playgroundInputError && (
              <Alert type="error" showIcon message={playgroundInputError} style={{ marginTop: 8 }} />
            )}

            <Collapse size="small" ghost style={{ marginTop: 12 }}>
              <Panel header="Input Schema" key="schema">
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
              <span style={{ fontWeight: 500 }}>Result</span>
              {playgroundJob?.status && (
                <Tag color={STATUS_CONFIG[playgroundJob.status]?.color || 'default'}>
                  {STATUS_CONFIG[playgroundJob.status]?.label || playgroundJob.status}
                </Tag>
              )}
            </div>

            {!playgroundJob ? (
              <Empty description="Run a test to see job output" imageStyle={{ height: 48 }} />
            ) : (
              <div>
                <Space style={{ marginBottom: 8 }} wrap>
                  <Tag>Job #{playgroundJob.id}</Tag>
                  {playgroundJob.currentStep && <Tag>Step {playgroundJob.currentStep}</Tag>}
                </Space>

                {playgroundJob.error && (
                  <Alert
                    type="error"
                    showIcon
                    message="Pipeline error"
                    description={<pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{playgroundJob.error}</pre>}
                    style={{ marginBottom: 12 }}
                  />
                )}

                <div style={{ fontWeight: 500, marginBottom: 4 }}>Final Result</div>
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
                    : '(not yet available)'}
                </pre>

                <div style={{ fontWeight: 500, margin: '12px 0 4px' }}>Step Results</div>
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
