import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Select,
  Switch,
  message,
  InputNumber,
  Tabs,
  Space,
  Tag,
  Popconfirm,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { useFlowContext } from '@nocobase/flow-engine';
import { useT } from '../locale';
import { EndpointDef, unwrapData } from '../types';

const { TextArea } = Input;

interface HeaderRow {
  id: string;
  key: string;
  value: string;
}

const sanitizeHeaders = (headers?: Record<string, string>) =>
  Object.entries(headers || {}).reduce<Record<string, string>>((acc, [key, value]) => {
    const headerName = key.trim();
    if (headerName) {
      acc[headerName] = value;
    }
    return acc;
  }, {});

const KeyValueEditor: React.FC<{ value?: Record<string, string>; onChange?: (v: Record<string, string>) => void }> = ({
  value,
  onChange,
}) => {
  const t = useT();
  const [rows, setRows] = useState<HeaderRow[]>([]);
  const syncedRef = useRef<string>();

  // A half-typed row (blank name) has no representation in `value`, so resync only on a genuine
  // outside change. Comparing serialized content — not object identity — keeps such rows alive.
  const serialized = JSON.stringify(value ?? {});

  useEffect(() => {
    if (syncedRef.current === serialized) return;
    syncedRef.current = serialized;
    setRows(
      Object.entries(JSON.parse(serialized) as Record<string, string>).map(([key, rowValue], index) => ({
        id: `${key}_${index}`,
        key,
        value: String(rowValue ?? ''),
      })),
    );
  }, [serialized]);

  const emit = (nextRows: HeaderRow[]) => {
    setRows(nextRows);
    const nextValue = nextRows.reduce<Record<string, string>>((acc, row) => {
      const key = row.key.trim();
      if (key) {
        acc[key] = row.value;
      }
      return acc;
    }, {});
    syncedRef.current = JSON.stringify(nextValue);
    onChange?.(nextValue);
  };

  const update = (idx: number, key: string, val: string) => {
    const nextRows = [...rows];
    nextRows[idx] = { ...nextRows[idx], key, value: val };
    emit(nextRows);
  };

  const add = () => setRows([...rows, { id: `new_${Date.now()}_${Math.random()}`, key: '', value: '' }]);

  const remove = (idx: number) => {
    emit(rows.filter((_, rowIndex) => rowIndex !== idx));
  };

  return (
    <div>
      {rows.map((row, i) => (
        <Space key={row.id} style={{ display: 'flex', marginBottom: 4 }}>
          <Input
            placeholder={t('Header name')}
            aria-label={t('Header name')}
            value={row.key}
            onChange={(e) => update(i, e.target.value, row.value)}
            style={{ width: 180 }}
          />
          <Input
            placeholder={t('Value')}
            aria-label={t('Value')}
            value={row.value}
            onChange={(e) => update(i, row.key, e.target.value)}
            style={{ width: 220 }}
          />
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => remove(i)}
            aria-label={`${t('Delete')} ${row.key || t('Header name')}`}
          />
        </Space>
      ))}
      <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={add}>
        {t('Add Header')}
      </Button>
    </div>
  );
};

const JsonEditor: React.FC<{ value?: unknown; onChange?: (v: unknown) => void; placeholder?: string }> = ({
  value,
  onChange,
  placeholder,
}) => {
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
        rows={6}
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

export const EndpointsTab = () => {
  const ctx = useFlowContext();
  const api = ctx.api;
  const t = useT();
  const [data, setData] = useState<EndpointDef[]>([]);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(false);
  const [form] = Form.useForm<Partial<EndpointDef>>();
  const [editingId, setEditingId] = useState<number | null>(null);

  const executionLabels: Record<string, string> = {
    sync: t('Synchronous'),
    polling: t('Polling'),
    webhook: t('Webhook'),
  };

  const fileModeLabels: Record<string, string> = {
    multipart: t('Multipart Upload'),
    base64: t('Base64 in JSON'),
  };

  const fetchEndpoints = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request({ url: 'docUnderstanding:listEndpoints' });
      setData(unwrapData<EndpointDef[]>(res, []));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchEndpoints();
  }, [fetchEndpoints]);

  const openEdit = (record: EndpointDef) => {
    setEditingId(record.id);
    form.setFieldsValue(record);
    setVisible(true);
  };

  const openAdd = () => {
    setEditingId(null);
    form.resetFields();
    setVisible(true);
  };

  const handleDelete = async (id: number) => {
    await api.request({
      url: 'docUnderstanding:deleteEndpoint',
      method: 'POST',
      params: { filterByTk: id },
    });
    message.success(t('Deleted'));
    fetchEndpoints();
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      values.customHeaders = sanitizeHeaders(values.customHeaders);
      if (editingId) {
        await api.request({
          url: 'docUnderstanding:updateEndpoint',
          method: 'POST',
          params: { filterByTk: editingId },
          data: values,
        });
      } else {
        await api.request({
          url: 'docUnderstanding:createEndpoint',
          method: 'POST',
          data: values,
        });
      }
      message.success(t('Saved'));
      setVisible(false);
      fetchEndpoints();
    } catch {
      // Form validation errors are already surfaced inline by antd.
    }
  };

  const columns: ColumnsType<EndpointDef> = [
    { title: t('Name'), dataIndex: 'name', width: 150 },
    { title: t('Subpath'), dataIndex: 'subpath', width: 200 },
    {
      title: t('Method'),
      dataIndex: 'method',
      width: 80,
      render: (v: string) => <Tag>{v}</Tag>,
    },
    {
      title: t('Execution'),
      dataIndex: 'executionMode',
      width: 130,
      render: (v: string) => {
        const colors: Record<string, string> = { sync: 'green', polling: 'blue', webhook: 'purple' };
        return <Tag color={colors[v]}>{executionLabels[v] || v}</Tag>;
      },
    },
    {
      title: t('File'),
      dataIndex: 'fileInputMode',
      width: 130,
      render: (v: string) => (v === 'none' ? '-' : fileModeLabels[v] || v),
    },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      width: 70,
      render: (v: boolean) => (v ? <Tag color="success">{t('Yes')}</Tag> : <Tag>{t('No')}</Tag>),
    },
    {
      title: t('Action'),
      width: 120,
      render: (_: unknown, record) => (
        <Space>
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => openEdit(record)}
            aria-label={`${t('Edit')} ${record.name}`}
          >
            {t('Edit')}
          </Button>
          <Popconfirm title={t('Delete this endpoint?')} okText={t('Delete')} onConfirm={() => handleDelete(record.id)}>
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
          {t('Add Endpoint')}
        </Button>
      </div>
      <Table rowKey="id" columns={columns} dataSource={data} loading={loading} size="small" />

      <Modal
        title={editingId ? t('Edit Endpoint') : t('Add Endpoint')}
        open={visible}
        onOk={handleSave}
        onCancel={() => setVisible(false)}
        okText={t('Save')}
        cancelText={t('Cancel')}
        width={680}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Tabs
            size="small"
            items={[
              {
                key: 'basic',
                label: t('Basic'),
                children: (
                  <>
                    <Form.Item name="name" label={t('Unique Name')} rules={[{ required: true }]}>
                      <Input placeholder="ocr, classify, extract..." />
                    </Form.Item>
                    <Form.Item name="subpath" label={t('Subpath')} rules={[{ required: true }]}>
                      <Input placeholder="/api/v1/ocr" />
                    </Form.Item>
                    <Form.Item name="description" label={t('Description')}>
                      <TextArea rows={2} placeholder={t('What this endpoint does')} />
                    </Form.Item>
                    <Space size="large">
                      <Form.Item name="method" label={t('HTTP Method')} initialValue="POST">
                        <Select
                          style={{ width: 120 }}
                          options={[
                            { value: 'GET', label: 'GET' },
                            { value: 'POST', label: 'POST' },
                            { value: 'PUT', label: 'PUT' },
                          ]}
                        />
                      </Form.Item>
                      <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked" initialValue={true}>
                        <Switch />
                      </Form.Item>
                    </Space>
                  </>
                ),
              },
              {
                key: 'file',
                label: t('File Input'),
                children: (
                  <>
                    <Form.Item name="fileInputMode" label={t('File Input Mode')} initialValue="none">
                      <Select
                        style={{ width: 200 }}
                        options={[
                          { value: 'none', label: t('None') },
                          { value: 'multipart', label: t('Multipart Upload') },
                          { value: 'base64', label: t('Base64 in JSON') },
                        ]}
                      />
                    </Form.Item>
                    <Form.Item noStyle dependencies={['fileInputMode']}>
                      {() =>
                        form.getFieldValue('fileInputMode') !== 'none' ? (
                          <>
                            <Form.Item name="fileFieldName" label={t('File Field Name')} initialValue="file">
                              <Input placeholder="file" style={{ width: 200 }} />
                            </Form.Item>
                            <Form.Item name="maxFiles" label={t('Max Files')} initialValue={1}>
                              <InputNumber min={1} max={20} style={{ width: 120 }} />
                            </Form.Item>
                          </>
                        ) : null
                      }
                    </Form.Item>
                  </>
                ),
              },
              {
                key: 'gateway',
                label: t('Gateway / Discriminator'),
                children: (
                  <>
                    <Form.Item
                      name="discriminatorField"
                      label={t('Discriminator Field')}
                      help={t(
                        'Form field that selects the API sub-case (e.g. mode/type/task/action/process). Sent automatically.',
                      )}
                    >
                      <Input placeholder="mode" style={{ width: 200 }} />
                    </Form.Item>
                    <Form.Item
                      name="discriminatorValue"
                      label={t('Discriminator Value')}
                      help={t('Value sent in the discriminator field (e.g. parse, invoice, disbursement).')}
                    >
                      <Input placeholder="parse" style={{ width: 200 }} />
                    </Form.Item>
                    <Form.Item
                      name="syncQueryParam"
                      label={t('Sync Query Param')}
                      help={t(
                        'When set, the request appends ?<param>=true to ask for a synchronous response (e.g. sync).',
                      )}
                    >
                      <Input placeholder="sync" style={{ width: 200 }} />
                    </Form.Item>
                    <Form.Item
                      name="taskIdExtractPath"
                      label={t('Task ID Extract Path')}
                      help={t(
                        'JSON path of the async task id in the 202 response (e.g. name). Used when the response is 202 even in sync mode.',
                      )}
                    >
                      <Input placeholder="name" style={{ width: 200 }} />
                    </Form.Item>
                    <Form.Item
                      name="taskIdExtractRegex"
                      label={t('Task ID Extract Regex')}
                      help={t(
                        'Regex with one capture group to pull the task id from the extracted path value (e.g. operations/([^/]+)).',
                      )}
                    >
                      <Input placeholder="operations/([^/]+)" style={{ width: 240 }} />
                    </Form.Item>
                  </>
                ),
              },
              {
                key: 'async',
                label: t('Async Config'),
                children: (
                  <>
                    <Form.Item name="executionMode" label={t('Execution Mode')} initialValue="sync">
                      <Select
                        style={{ width: 200 }}
                        options={[
                          { value: 'sync', label: t('Synchronous') },
                          { value: 'polling', label: t('Polling') },
                          { value: 'webhook', label: t('Webhook') },
                        ]}
                      />
                    </Form.Item>
                    <Form.Item noStyle dependencies={['executionMode']}>
                      {() => {
                        const mode = form.getFieldValue('executionMode');
                        if (mode === 'sync') return null;
                        return (
                          <>
                            <Form.Item
                              name="pollTaskIdField"
                              label={t('Task ID Field')}
                              help={t('Field in response containing the async task ID')}
                              initialValue="task_id"
                            >
                              <Input placeholder="task_id" />
                            </Form.Item>

                            {mode === 'polling' && (
                              <>
                                <Form.Item
                                  name="pollResultSubpath"
                                  label={t('Poll Result Subpath')}
                                  help={t('URL to poll for result. Use {taskId} as placeholder.')}
                                  rules={[{ required: true, message: t('Required for polling mode') }]}
                                >
                                  <Input placeholder="/api/v1/tasks/{taskId}/result" />
                                </Form.Item>
                                <Form.Item
                                  name="pollResultField"
                                  label={t('Result Field')}
                                  help={t('Field in poll response containing the actual result')}
                                >
                                  <Input placeholder="result" />
                                </Form.Item>
                                <Form.Item
                                  name="pollStatusField"
                                  label={t('Status Field (optional)')}
                                  help={t(
                                    'Field to check completion status. If empty, any non-null result = complete.',
                                  )}
                                >
                                  <Input placeholder="status" />
                                </Form.Item>
                                <Form.Item
                                  name="pollCompletedValue"
                                  label={t('Completed Value')}
                                  help={t("Value of status field that means 'done'")}
                                  initialValue="completed"
                                >
                                  <Input placeholder="completed" />
                                </Form.Item>
                                <Space size="large">
                                  <Form.Item
                                    name="pollInterval"
                                    label={t('Poll Interval (ms)')}
                                    help={t('Override default')}
                                  >
                                    <InputNumber min={1000} step={1000} placeholder="5000" style={{ width: 150 }} />
                                  </Form.Item>
                                  <Form.Item
                                    name="pollTimeout"
                                    label={t('Poll Timeout (ms)')}
                                    help={t('Override default')}
                                  >
                                    <InputNumber min={5000} step={5000} placeholder="300000" style={{ width: 150 }} />
                                  </Form.Item>
                                </Space>
                              </>
                            )}
                          </>
                        );
                      }}
                    </Form.Item>
                  </>
                ),
              },
              {
                key: 'schema',
                label: t('Schema'),
                children: (
                  <>
                    <Form.Item name="requestBodySchema" label={t('Request Body Schema (JSON Schema)')}>
                      <JsonEditor placeholder='{ "type": "object", "properties": { ... } }' />
                    </Form.Item>
                    <Form.Item name="responseSchema" label={t('Response Schema (JSON Schema)')}>
                      <JsonEditor placeholder='{ "type": "object", "properties": { ... } }' />
                    </Form.Item>
                  </>
                ),
              },
              {
                key: 'headers',
                label: t('Custom Headers'),
                children: (
                  <Form.Item name="customHeaders" label={t('Additional Headers')}>
                    <KeyValueEditor />
                  </Form.Item>
                ),
              },
            ]}
          />
        </Form>
      </Modal>
    </div>
  );
};
