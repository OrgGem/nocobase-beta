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
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';

const { TextArea } = Input;

const KeyValueEditor: React.FC<{ value?: Record<string, string>; onChange?: (v: Record<string, string>) => void }> = ({
  value = {},
  onChange,
}) => {
  const [rows, setRows] = useState<Array<{ id: string; key: string; value: string }>>([]);
  const localChangeRef = useRef(false);

  useEffect(() => {
    if (localChangeRef.current) {
      localChangeRef.current = false;
      return;
    }
    setRows(
      Object.entries(value || {}).map(([key, rowValue], index) => ({
        id: `${key}_${index}`,
        key,
        value: String(rowValue ?? ''),
      })),
    );
  }, [value]);

  const emit = (nextRows: Array<{ id: string; key: string; value: string }>) => {
    setRows(nextRows);
    const nextValue = nextRows.reduce<Record<string, string>>((acc, row) => {
      const key = row.key.trim();
      if (key) {
        acc[key] = row.value;
      }
      return acc;
    }, {});
    localChangeRef.current = true;
    onChange?.(nextValue);
  };

  const update = (idx: number, key: string, val: string) => {
    const nextRows = [...rows];
    nextRows[idx] = { ...nextRows[idx], key, value: val };
    emit(nextRows);
  };

  const add = () => setRows([...rows, { id: `new_${Date.now()}_${Math.random()}`, key: '', value: '' }]);

  const remove = (idx: number) => {
    const nextRows = rows.filter((_, rowIndex) => rowIndex !== idx);
    emit(nextRows);
  };

  return (
    <div>
      {rows.map((row, i) => (
        <Space key={row.id} style={{ display: 'flex', marginBottom: 4 }}>
          <Input
            placeholder="Header name"
            value={row.key}
            onChange={(e) => update(i, e.target.value, row.value)}
            style={{ width: 180 }}
          />
          <Input
            placeholder="Value"
            value={row.value}
            onChange={(e) => update(i, row.key, e.target.value)}
            style={{ width: 220 }}
          />
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => remove(i)} />
        </Space>
      ))}
      <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={add}>
        Add Header
      </Button>
    </div>
  );
};

const JsonEditor: React.FC<{ value?: any; onChange?: (v: any) => void; placeholder?: string }> = ({
  value,
  onChange,
  placeholder,
}) => {
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
        rows={6}
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

export const EndpointsTab = () => {
  const api = useAPIClient();
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(false);
  const [form] = Form.useForm();
  const [editingId, setEditingId] = useState<number | null>(null);

  const fetchEndpoints = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request({ url: 'docUnderstanding:listEndpoints' });
      setData(res.data?.data || []);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchEndpoints();
  }, [fetchEndpoints]);

  const openEdit = (record: any) => {
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
    message.success('Deleted');
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
      message.success('Saved');
      setVisible(false);
      fetchEndpoints();
    } catch {
      // validation error
    }
  };

  const sanitizeHeaders = (headers?: Record<string, string>) => {
    return Object.entries(headers || {}).reduce<Record<string, string>>((acc, [key, value]) => {
      const headerName = key.trim();
      if (headerName) {
        acc[headerName] = value;
      }
      return acc;
    }, {});
  };

  const columns = [
    { title: 'Name', dataIndex: 'name', width: 150 },
    { title: 'Subpath', dataIndex: 'subpath', width: 200 },
    {
      title: 'Method',
      dataIndex: 'method',
      width: 80,
      render: (v: string) => <Tag>{v}</Tag>,
    },
    {
      title: 'Execution',
      dataIndex: 'executionMode',
      width: 100,
      render: (v: string) => {
        const colors: Record<string, string> = { sync: 'green', polling: 'blue', webhook: 'purple' };
        return <Tag color={colors[v]}>{v}</Tag>;
      },
    },
    {
      title: 'File',
      dataIndex: 'fileInputMode',
      width: 90,
      render: (v: string) => (v === 'none' ? '-' : v),
    },
    {
      title: 'Enabled',
      dataIndex: 'enabled',
      width: 70,
      render: (v: boolean) => (v ? <Tag color="success">Yes</Tag> : <Tag>No</Tag>),
    },
    {
      title: 'Action',
      width: 120,
      render: (_: any, record: any) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            Edit
          </Button>
          <Popconfirm title="Delete this endpoint?" onConfirm={() => handleDelete(record.id)}>
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
          Add Endpoint
        </Button>
      </div>
      <Table rowKey="id" columns={columns} dataSource={data} loading={loading} size="small" />

      <Modal
        title={editingId ? 'Edit Endpoint' : 'Add Endpoint'}
        open={visible}
        onOk={handleSave}
        onCancel={() => setVisible(false)}
        width={680}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Tabs
            size="small"
            items={[
              {
                key: 'basic',
                label: 'Basic',
                children: (
                  <>
                    <Form.Item name="name" label="Unique Name" rules={[{ required: true }]}>
                      <Input placeholder="ocr, classify, extract..." />
                    </Form.Item>
                    <Form.Item name="subpath" label="Subpath" rules={[{ required: true }]}>
                      <Input placeholder="/api/v1/ocr" />
                    </Form.Item>
                    <Form.Item name="description" label="Description">
                      <TextArea rows={2} placeholder="What this endpoint does" />
                    </Form.Item>
                    <Space size="large">
                      <Form.Item name="method" label="HTTP Method" initialValue="POST">
                        <Select style={{ width: 120 }}>
                          <Select.Option value="GET">GET</Select.Option>
                          <Select.Option value="POST">POST</Select.Option>
                          <Select.Option value="PUT">PUT</Select.Option>
                        </Select>
                      </Form.Item>
                      <Form.Item name="enabled" label="Enabled" valuePropName="checked" initialValue={true}>
                        <Switch />
                      </Form.Item>
                    </Space>
                  </>
                ),
              },
              {
                key: 'file',
                label: 'File Input',
                children: (
                  <>
                    <Form.Item name="fileInputMode" label="File Input Mode" initialValue="none">
                      <Select style={{ width: 200 }}>
                        <Select.Option value="none">None</Select.Option>
                        <Select.Option value="multipart">Multipart Upload</Select.Option>
                        <Select.Option value="base64">Base64 in JSON</Select.Option>
                      </Select>
                    </Form.Item>
                    <Form.Item noStyle dependencies={['fileInputMode']}>
                      {() =>
                        form.getFieldValue('fileInputMode') !== 'none' ? (
                          <>
                            <Form.Item name="fileFieldName" label="File Field Name" initialValue="file">
                              <Input placeholder="file" style={{ width: 200 }} />
                            </Form.Item>
                            <Form.Item name="maxFiles" label="Max Files" initialValue={1}>
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
                key: 'async',
                label: 'Async Config',
                children: (
                  <>
                    <Form.Item name="executionMode" label="Execution Mode" initialValue="sync">
                      <Select style={{ width: 200 }}>
                        <Select.Option value="sync">Synchronous</Select.Option>
                        <Select.Option value="polling">Polling</Select.Option>
                        <Select.Option value="webhook">Webhook</Select.Option>
                      </Select>
                    </Form.Item>
                    <Form.Item noStyle dependencies={['executionMode']}>
                      {() => {
                        const mode = form.getFieldValue('executionMode');
                        if (mode === 'sync') return null;
                        return (
                          <>
                            <Form.Item
                              name="pollTaskIdField"
                              label="Task ID Field"
                              help="Field in response containing the async task ID"
                              initialValue="task_id"
                            >
                              <Input placeholder="task_id" />
                            </Form.Item>

                            {mode === 'polling' && (
                              <>
                                <Form.Item
                                  name="pollResultSubpath"
                                  label="Poll Result Subpath"
                                  help="URL to poll for result. Use {taskId} as placeholder."
                                  rules={[{ required: true, message: 'Required for polling mode' }]}
                                >
                                  <Input placeholder="/api/v1/tasks/{taskId}/result" />
                                </Form.Item>
                                <Form.Item
                                  name="pollResultField"
                                  label="Result Field"
                                  help="Field in poll response containing the actual result"
                                >
                                  <Input placeholder="result" />
                                </Form.Item>
                                <Form.Item
                                  name="pollStatusField"
                                  label="Status Field (optional)"
                                  help="Field to check completion status. If empty, any non-null result = complete."
                                >
                                  <Input placeholder="status" />
                                </Form.Item>
                                <Form.Item
                                  name="pollCompletedValue"
                                  label="Completed Value"
                                  help="Value of status field that means 'done'"
                                  initialValue="completed"
                                >
                                  <Input placeholder="completed" />
                                </Form.Item>
                                <Space size="large">
                                  <Form.Item name="pollInterval" label="Poll Interval (ms)" help="Override default">
                                    <InputNumber min={1000} step={1000} placeholder="5000" style={{ width: 150 }} />
                                  </Form.Item>
                                  <Form.Item name="pollTimeout" label="Poll Timeout (ms)" help="Override default">
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
                label: 'Schema',
                children: (
                  <>
                    <Form.Item name="requestBodySchema" label="Request Body Schema (JSON Schema)">
                      <JsonEditor placeholder='{ "type": "object", "properties": { ... } }' />
                    </Form.Item>
                    <Form.Item name="responseSchema" label="Response Schema (JSON Schema)">
                      <JsonEditor placeholder='{ "type": "object", "properties": { ... } }' />
                    </Form.Item>
                  </>
                ),
              },
              {
                key: 'headers',
                label: 'Custom Headers',
                children: (
                  <Form.Item name="customHeaders" label="Additional Headers">
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
