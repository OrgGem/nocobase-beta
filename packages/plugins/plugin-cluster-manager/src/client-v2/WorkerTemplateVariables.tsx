import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, EditOutlined, EyeOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useFlowContext } from '@nocobase/flow-engine';

type TemplateScope = 'global' | 'stack';

interface WorkerTemplateVariable {
  id: number;
  key: string;
  value: string;
  valueType: string;
  category: string;
  scope: TemplateScope;
  stackId?: number | null;
  description?: string;
  required: boolean;
  systemManaged: boolean;
  overridable: boolean;
  secret: boolean;
  enabled: boolean;
  sort: number;
  masked?: boolean;
}

interface StackOption {
  id: number;
  name: string;
}

interface VariableFormValues {
  id?: number;
  key: string;
  value?: string;
  valueType: string;
  category: string;
  scope: TemplateScope;
  stackId?: number;
  description?: string;
  required: boolean;
  overridable: boolean;
  secret: boolean;
  enabled: boolean;
  sort: number;
}

function getResponseData<T>(response: unknown): T | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  return (data as { data?: T }).data;
}

function getResponseArray<T>(response: unknown): T[] {
  const data = getResponseData<T[]>(response);
  return Array.isArray(data) ? data : [];
}

export default function WorkerTemplateVariables() {
  const ctx = useFlowContext();
  const [form] = Form.useForm<VariableFormValues>();
  const [variables, setVariables] = useState<WorkerTemplateVariable[]>([]);
  const [stacks, setStacks] = useState<StackOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [previewStackId, setPreviewStackId] = useState<number>();
  const [preview, setPreview] = useState<Record<string, string>>();

  const t = useCallback((key: string) => ctx.t(key, { ns: 'cluster-manager' }), [ctx]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [variablesResponse, stacksResponse] = await Promise.all([
        ctx.api.request({ url: 'workerTemplate:list', method: 'get' }),
        ctx.api.request({ url: 'orchestratorStacks:list', method: 'get', params: { pageSize: 100 } }),
      ]);
      setVariables(getResponseArray<WorkerTemplateVariable>(variablesResponse));
      setStacks(getResponseArray<StackOption>(stacksResponse));
    } catch {
      message.error(t('Failed to load worker template variables'));
    } finally {
      setLoading(false);
    }
  }, [ctx.api, t]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = useCallback(
    (scope: TemplateScope) => {
      form.resetFields();
      form.setFieldsValue({
        scope,
        valueType: 'string',
        category: 'custom',
        required: false,
        overridable: true,
        secret: false,
        enabled: true,
        sort: 0,
      });
      setModalOpen(true);
    },
    [form],
  );

  const openEdit = useCallback(
    (variable: WorkerTemplateVariable) => {
      form.setFieldsValue({
        ...variable,
        value: variable.secret ? '' : variable.value,
      });
      setModalOpen(true);
    },
    [form],
  );

  const save = useCallback(async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await ctx.api.request({ url: 'workerTemplate:upsert', method: 'post', data: values });
      message.success(t('Worker template variable saved'));
      setModalOpen(false);
      await load();
    } catch {
      message.error(t('Failed to save worker template variable'));
    } finally {
      setSaving(false);
    }
  }, [ctx.api, form, load, t]);

  const remove = useCallback(
    async (variable: WorkerTemplateVariable) => {
      try {
        await ctx.api.request({ url: 'workerTemplate:destroy', method: 'post', data: { id: variable.id } });
        message.success(t('Worker template variable removed'));
        await load();
      } catch {
        message.error(t('Failed to remove worker template variable'));
      }
    },
    [ctx.api, load, t],
  );

  const loadPreview = useCallback(async () => {
    if (!previewStackId) return;
    try {
      const response = await ctx.api.request({
        url: 'workerTemplate:preview',
        method: 'get',
        params: { stackId: previewStackId },
      });
      const data = getResponseData<{ envVars?: Record<string, string> }>(response);
      setPreview(data?.envVars || {});
    } catch {
      message.error(t('Failed to resolve worker template'));
    }
  }, [ctx.api, previewStackId, t]);

  const columns = useMemo<ColumnsType<WorkerTemplateVariable>>(
    () => [
      { title: t('Key'), dataIndex: 'key', key: 'key', width: 240 },
      {
        title: t('Value'),
        dataIndex: 'value',
        key: 'value',
        render: (value: string, variable) =>
          variable.secret ? <Typography.Text type="secondary">{value || '••••••••'}</Typography.Text> : value,
      },
      { title: t('Category'), dataIndex: 'category', key: 'category', width: 120 },
      {
        title: t('State'),
        dataIndex: 'enabled',
        key: 'enabled',
        width: 130,
        render: (enabled: boolean, variable) => (
          <Space size={4}>
            <Tag color={enabled ? 'green' : 'default'}>{enabled ? t('Enabled') : t('Disabled')}</Tag>
            {variable.secret ? <Tag color="purple">{t('Secret')}</Tag> : null}
          </Space>
        ),
      },
      {
        title: t('Actions'),
        key: 'actions',
        width: 110,
        render: (_value, variable) => (
          <Space>
            <Button
              aria-label={t('Edit worker template variable')}
              type="text"
              icon={<EditOutlined />}
              onClick={() => openEdit(variable)}
            />
            <Button
              aria-label={t('Remove worker template variable')}
              type="text"
              danger
              disabled={variable.systemManaged}
              icon={<DeleteOutlined />}
              onClick={() => remove(variable)}
            />
          </Space>
        ),
      },
    ],
    [openEdit, remove, t],
  );

  const globalVariables = variables.filter((variable) => variable.scope === 'global');
  const stackVariables = variables.filter((variable) => variable.scope === 'stack');

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex', padding: 24 }}>
      <Alert
        type="info"
        showIcon
        message={t('Worker template contract')}
        description={t(
          'Workers always enforce APP_ROLE=worker, APP_NODE_ROLE=worker, and a resolved WORKER_MODE. The bootstrap waits for the configured readiness URL and never runs install or upgrade.',
        )}
      />
      <Tabs
        items={[
          {
            key: 'global',
            label: t('Global worker environment'),
            children: (
              <Card
                extra={
                  <Space>
                    <Button icon={<ReloadOutlined />} onClick={load}>
                      {t('Refresh')}
                    </Button>
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate('global')}>
                      {t('Add variable')}
                    </Button>
                  </Space>
                }
              >
                <Table
                  rowKey="id"
                  loading={loading}
                  columns={columns}
                  dataSource={globalVariables}
                  scroll={{ x: 850 }}
                  pagination={false}
                />
              </Card>
            ),
          },
          {
            key: 'stack',
            label: t('Per-stack overrides'),
            children: (
              <Card
                extra={
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate('stack')}>
                    {t('Add override')}
                  </Button>
                }
              >
                <Table
                  rowKey="id"
                  loading={loading}
                  columns={[
                    ...columns.slice(0, 4),
                    {
                      title: t('Stack'),
                      dataIndex: 'stackId',
                      key: 'stackId',
                      width: 180,
                      render: (stackId: number) => stacks.find((stack) => stack.id === stackId)?.name || `#${stackId}`,
                    },
                    columns[4],
                  ]}
                  dataSource={stackVariables}
                  scroll={{ x: 1000 }}
                  pagination={false}
                />
              </Card>
            ),
          },
          {
            key: 'preview',
            label: t('Resolved preview'),
            children: (
              <Card>
                <Space wrap style={{ marginBottom: 16 }}>
                  <Select
                    aria-label={t('Worker stack')}
                    placeholder={t('Select worker stack')}
                    style={{ minWidth: 240 }}
                    options={stacks.map((stack) => ({ value: stack.id, label: stack.name }))}
                    value={previewStackId}
                    onChange={setPreviewStackId}
                  />
                  <Button icon={<EyeOutlined />} disabled={!previewStackId} onClick={loadPreview}>
                    {t('Resolve preview')}
                  </Button>
                </Space>
                <Table
                  rowKey="key"
                  pagination={false}
                  dataSource={Object.entries(preview || {}).map(([key, value]) => ({ key, value }))}
                  columns={[
                    { title: t('Key'), dataIndex: 'key', key: 'key' },
                    { title: t('Value'), dataIndex: 'value', key: 'value' },
                  ]}
                />
              </Card>
            ),
          },
        ]}
      />
      <Modal
        open={modalOpen}
        title={form.getFieldValue('id') ? t('Edit worker template variable') : t('Add worker template variable')}
        onCancel={() => setModalOpen(false)}
        onOk={save}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="id" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="scope" label={t('Scope')} rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'global', label: t('Global') },
                { value: 'stack', label: t('Stack') },
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(previous, current) => previous.scope !== current.scope}>
            {({ getFieldValue }) =>
              getFieldValue('scope') === 'stack' ? (
                <Form.Item name="stackId" label={t('Stack')} rules={[{ required: true }]}>
                  <Select options={stacks.map((stack) => ({ value: stack.id, label: stack.name }))} />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          <Form.Item name="key" label={t('Key')} rules={[{ required: true, pattern: /^[A-Z_][A-Z0-9_]*$/ }]}>
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item name="value" label={t('Value')}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="description" label={t('Description')}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <Space size="large">
            <Form.Item name="secret" label={t('Secret')} valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="required" label={t('Required')} valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="sort" label={t('Sort')}>
              <InputNumber min={0} />
            </Form.Item>
          </Space>
          <Form.Item name="valueType" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="category" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="overridable" hidden>
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
