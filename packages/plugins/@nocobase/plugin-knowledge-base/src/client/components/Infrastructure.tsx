/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useState, useEffect } from 'react';
import { useAPIClient } from '@nocobase/client';
import {
  Button,
  Modal,
  Form,
  Input,
  Select,
  Space,
  message,
  Popconfirm,
  Tag,
  Typography,
  Row,
  Col,
  Card,
  Empty,
  Spin,
  Tabs,
  InputNumber,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ApiOutlined,
  DatabaseOutlined,
  HddOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  SettingOutlined,
} from '@ant-design/icons';

const { Text, Title } = Typography;

export const Infrastructure: React.FC = () => {
  const api = useAPIClient();

  // ----- Vector Databases State -----
  const [vectorDatabases, setVectorDatabases] = useState<any[]>([]);
  const [vdLoading, setVdLoading] = useState(false);
  const [vdModalVisible, setVdModalVisible] = useState(false);
  const [vdEditingRecord, setVdEditingRecord] = useState<any>(null);
  const [vdTestResult, setVdTestResult] = useState<{ success?: boolean; error?: string } | null>(null);
  const [vdTesting, setVdTesting] = useState(false);
  const [vdForm] = Form.useForm();

  // ----- Vector Stores State -----
  const [vectorStores, setVectorStores] = useState<any[]>([]);
  const [vsLoading, setVsLoading] = useState(false);
  const [vsModalVisible, setVsModalVisible] = useState(false);
  const [vsEditingRecord, setVsEditingRecord] = useState<any>(null);
  const [llmServices, setLlmServices] = useState<any[]>([]);
  const [embeddingModels, setEmbeddingModels] = useState<any[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [vsForm] = Form.useForm();

  // ----- Shared -----
  const [activeTab, setActiveTab] = useState('databases');

  const fetchVectorDatabases = async () => {
    setVdLoading(true);
    try {
      const res = await api.request({ url: 'aiVectorDatabase:list' });
      setVectorDatabases(res?.data?.data ?? []);
    } catch {
      message.error('Failed to load vector databases');
    } finally {
      setVdLoading(false);
    }
  };

  const fetchVectorStores = async () => {
    setVsLoading(true);
    try {
      const res = await api.request({ url: 'aiVectorStore:list' });
      setVectorStores(res?.data?.data ?? []);
    } catch {
      message.error('Failed to load vector stores');
    } finally {
      setVsLoading(false);
    }
  };

  const fetchLLMServices = async () => {
    try {
      const res = await api.request({ url: 'ai:listLLMServices' });
      setLlmServices(res?.data?.data ?? []);
    } catch {
      // ignore
    }
  };

  const fetchEmbeddingModels = async (llmServiceName: string) => {
    setModelsLoading(true);
    setEmbeddingModels([]);
    try {
      const res = await api.request({
        url: 'ai:listModels',
        params: { llmService: llmServiceName },
      });
      setEmbeddingModels(res?.data?.data ?? []);
    } catch {
      setEmbeddingModels([]);
    } finally {
      setModelsLoading(false);
    }
  };

  useEffect(() => {
    fetchVectorDatabases();
    fetchVectorStores();
    fetchLLMServices();
  }, []);

  // ==========================================
  // Vector Databases Handlers
  // ==========================================
  const handleVdCreate = () => {
    setVdEditingRecord(null);
    setVdTestResult(null);
    vdForm.resetFields();
    vdForm.setFieldsValue({ provider: 'pgvector', port: 5432, host: 'localhost' });
    setVdModalVisible(true);
  };

  const handleVdEdit = (record: any) => {
    setVdEditingRecord(record);
    setVdTestResult(null);
    vdForm.setFieldsValue({
      name: record.name,
      provider: record.provider,
      ...record.connectParams,
    });
    setVdModalVisible(true);
  };

  const handleVdTest = async () => {
    setVdTesting(true);
    setVdTestResult(null);
    try {
      const formValues = await vdForm.validateFields();
      const { name, provider, ...connectParams } = formValues;
      const res = await api.request({
        url: 'aiVectorDatabase:test',
        method: 'post',
        data: { values: { provider, connectParams } },
      });
      setVdTestResult(res?.data?.data ?? { success: false, error: 'Unknown error' });
    } catch (err: any) {
      setVdTestResult({ success: false, error: err.message ?? 'Test failed' });
    } finally {
      setVdTesting(false);
    }
  };

  const handleVdSave = async () => {
    try {
      const formValues = await vdForm.validateFields();
      const { name, provider, ...connectParams } = formValues;
      const values = { name, provider, connectParams };

      if (vdEditingRecord) {
        await api.request({
          url: 'aiVectorDatabase:update',
          method: 'post',
          params: { filterByTk: vdEditingRecord.id },
          data: { values },
        });
        message.success('Updated successfully');
      } else {
        await api.request({ url: 'aiVectorDatabase:create', method: 'post', data: { values } });
        message.success('Created successfully');
      }
      setVdModalVisible(false);
      fetchVectorDatabases();
    } catch {
      message.error('Operation failed');
    }
  };

  const handleVdDelete = async (id: string) => {
    try {
      await api.request({ url: 'aiVectorDatabase:destroy', method: 'post', params: { filterByTk: id } });
      message.success('Deleted successfully');
      fetchVectorDatabases();
    } catch {
      message.error('Delete failed');
    }
  };

  // ==========================================
  // Vector Stores Handlers
  // ==========================================
  const handleVsCreate = () => {
    setVsEditingRecord(null);
    setEmbeddingModels([]);
    vsForm.resetFields();
    setVsModalVisible(true);
  };

  const handleVsEdit = (record: any) => {
    setVsEditingRecord(record);
    const formValues = { ...record };
    if (formValues.embeddingModel && !Array.isArray(formValues.embeddingModel)) {
      formValues.embeddingModel = [formValues.embeddingModel];
    }
    vsForm.setFieldsValue(formValues);
    setVsModalVisible(true);
    if (record.llmService) {
      fetchEmbeddingModels(record.llmService);
    }
  };

  const handleVsSave = async () => {
    try {
      const values = await vsForm.validateFields();
      if (Array.isArray(values.embeddingModel)) {
        values.embeddingModel = values.embeddingModel[0] || '';
      }
      if (vsEditingRecord) {
        await api.request({
          url: 'aiVectorStore:update',
          method: 'post',
          params: { filterByTk: vsEditingRecord.id },
          data: { values },
        });
        message.success('Updated successfully');
      } else {
        await api.request({ url: 'aiVectorStore:create', method: 'post', data: { values } });
        message.success('Created successfully');
      }
      setVsModalVisible(false);
      fetchVectorStores();
    } catch {
      message.error('Operation failed');
    }
  };

  const handleVsDelete = async (id: string) => {
    try {
      await api.request({ url: 'aiVectorStore:destroy', method: 'post', params: { filterByTk: id } });
      message.success('Deleted successfully');
      fetchVectorStores();
    } catch {
      message.error('Delete failed');
    }
  };

  // ==========================================
  // Renderers
  // ==========================================
  const llmServiceTitleMap = React.useMemo(() => {
    const map: Record<string, string> = {};
    llmServices.forEach((svc: any) => {
      map[svc.name] = svc.title || svc.name;
    });
    return map;
  }, [llmServices]);

  const renderVectorDatabases = () => (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 24, alignItems: 'center' }}>
        <div>
          <Title level={5} style={{ margin: 0 }}>
            Vector Databases
          </Title>
          <Text type="secondary">
            Physical databases storing the vector embeddings (e.g. PostgreSQL with pgvector).
          </Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleVdCreate}>
          Add Database
        </Button>
      </div>

      {vdLoading ? (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Spin size="large" />
        </div>
      ) : vectorDatabases.length === 0 ? (
        <Empty description="No vector databases configured" style={{ padding: 48 }} />
      ) : (
        <Row gutter={[16, 16]}>
          {vectorDatabases.map((vd) => (
            <Col span={8} key={vd.id}>
              <Card
                hoverable
                size="small"
                title={
                  <Space>
                    <HddOutlined style={{ color: '#1890ff' }} />
                    <Text strong>{vd.name}</Text>
                  </Space>
                }
                extra={<Tag color="blue">{vd.provider}</Tag>}
                actions={[
                  <Button type="text" key="edit" icon={<EditOutlined />} onClick={() => handleVdEdit(vd)}>
                    Edit
                  </Button>,
                  <Popconfirm key="delete" title="Delete this database?" onConfirm={() => handleVdDelete(vd.id)}>
                    <Button type="text" danger icon={<DeleteOutlined />}>
                      Delete
                    </Button>
                  </Popconfirm>,
                ]}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Text type="secondary">Host</Text>
                    <Text>
                      {vd.connectParams?.host}:{vd.connectParams?.port}
                    </Text>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Text type="secondary">Database</Text>
                    <Text>{vd.connectParams?.database}</Text>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Text type="secondary">Table</Text>
                    <Text>{vd.connectParams?.tableName}</Text>
                  </div>
                </div>
              </Card>
            </Col>
          ))}
        </Row>
      )}
    </>
  );

  const renderVectorStores = () => (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 24, alignItems: 'center' }}>
        <div>
          <Title level={5} style={{ margin: 0 }}>
            Vector Stores
          </Title>
          <Text type="secondary">Logical connections combining a vector database with an embedding model.</Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleVsCreate}>
          Add Vector Store
        </Button>
      </div>

      {vsLoading ? (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Spin size="large" />
        </div>
      ) : vectorStores.length === 0 ? (
        <Empty description="No vector stores configured" style={{ padding: 48 }} />
      ) : (
        <Row gutter={[16, 16]}>
          {vectorStores.map((vs) => (
            <Col span={8} key={vs.id}>
              <Card
                hoverable
                size="small"
                title={
                  <Space>
                    <DatabaseOutlined style={{ color: '#52c41a' }} />
                    <Text strong>{vs.name}</Text>
                  </Space>
                }
                actions={[
                  <Button type="text" key="edit" icon={<EditOutlined />} onClick={() => handleVsEdit(vs)}>
                    Edit
                  </Button>,
                  <Popconfirm key="delete" title="Delete this vector store?" onConfirm={() => handleVsDelete(vs.id)}>
                    <Button type="text" danger icon={<DeleteOutlined />}>
                      Delete
                    </Button>
                  </Popconfirm>,
                ]}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <HddOutlined style={{ color: '#8c8c8c' }} />
                    <Text type="secondary" style={{ width: 60 }}>
                      DB:
                    </Text>
                    <Text ellipsis>{vs.vectorDatabase?.name || 'Unknown'}</Text>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <ApiOutlined style={{ color: '#8c8c8c' }} />
                    <Text type="secondary" style={{ width: 60 }}>
                      LLM:
                    </Text>
                    <Text ellipsis>{llmServiceTitleMap[vs.llmService] || vs.llmService}</Text>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <SettingOutlined style={{ color: '#8c8c8c' }} />
                    <Text type="secondary" style={{ width: 60 }}>
                      Model:
                    </Text>
                    <Text ellipsis>{vs.embeddingModel}</Text>
                  </div>
                </div>
              </Card>
            </Col>
          ))}
        </Row>
      )}
    </>
  );

  return (
    <div style={{ padding: 32, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <Title level={3}>Knowledge Base Infrastructure</Title>
        <Text type="secondary">Manage the underlying infrastructure that powers your AI knowledge bases.</Text>
      </div>

      <Card bodyStyle={{ padding: 0 }}>
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          className="infrastructure-tabs"
          size="large"
          tabBarStyle={{ padding: '0 24px', margin: 0, backgroundColor: '#fafafa', borderBottom: '1px solid #f0f0f0' }}
          items={[
            {
              key: 'databases',
              label: (
                <span>
                  <HddOutlined />
                  Vector Databases
                </span>
              ),
              children: <div style={{ padding: 24, minHeight: 400 }}>{renderVectorDatabases()}</div>,
            },
            {
              key: 'stores',
              label: (
                <span>
                  <DatabaseOutlined />
                  Vector Stores
                </span>
              ),
              children: <div style={{ padding: 24, minHeight: 400 }}>{renderVectorStores()}</div>,
            },
          ]}
        />
      </Card>

      {/* Vector Database Modal */}
      <Modal
        title={vdEditingRecord ? 'Edit Vector Database' : 'Add Vector Database'}
        open={vdModalVisible}
        onOk={handleVdSave}
        onCancel={() => setVdModalVisible(false)}
        destroyOnClose
        width={600}
      >
        <Form form={vdForm} layout="vertical">
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="provider" label="Provider">
            <Select options={[{ label: 'PGVector', value: 'pgvector' }]} />
          </Form.Item>
          <Row gutter={16}>
            <Col span={16}>
              <Form.Item name="host" label="Host" rules={[{ required: true }]}>
                <Input placeholder="localhost" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="port" label="Port" rules={[{ required: true }]}>
                <InputNumber style={{ width: '100%' }} placeholder="5432" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="username" label="Username" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="password" label="Password">
                <Input.Password />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="database" label="Database" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="tableName" label="Table Name" rules={[{ required: true }]}>
                <Input placeholder="e.g. kb_vectors" />
              </Form.Item>
            </Col>
          </Row>
          <div
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              background: '#f5f5f5',
              padding: 12,
              borderRadius: 8,
            }}
          >
            <Button icon={<ApiOutlined />} loading={vdTesting} onClick={handleVdTest}>
              Test Connection
            </Button>
            {vdTestResult && (
              <Tag
                color={vdTestResult.success ? 'success' : 'error'}
                icon={vdTestResult.success ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
              >
                {vdTestResult.success ? 'Connection successful' : vdTestResult.error ?? 'Connection failed'}
              </Tag>
            )}
          </div>
        </Form>
      </Modal>

      {/* Vector Store Modal */}
      <Modal
        title={vsEditingRecord ? 'Edit Vector Store' : 'Add Vector Store'}
        open={vsModalVisible}
        onOk={handleVsSave}
        onCancel={() => setVsModalVisible(false)}
        destroyOnClose
        width={600}
      >
        <Form form={vsForm} layout="vertical">
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="vectorDatabaseId" label="Vector Database" rules={[{ required: true }]}>
            <Select options={vectorDatabases.map((vd) => ({ label: vd.name, value: vd.id }))} />
          </Form.Item>
          <Form.Item name="llmService" label="LLM Service" rules={[{ required: true }]}>
            <Select
              options={llmServices.map((svc) => ({ label: svc.title || svc.name, value: svc.name }))}
              onChange={(val) => {
                vsForm.setFieldValue('embeddingModel', undefined);
                fetchEmbeddingModels(val);
              }}
            />
          </Form.Item>
          <Form.Item name="embeddingModel" label="Embedding Model" rules={[{ required: true }]}>
            <Select
              showSearch
              allowClear
              mode="tags"
              maxCount={1}
              loading={modelsLoading}
              placeholder={modelsLoading ? 'Loading models...' : 'Type or select embedding model'}
              options={embeddingModels.map((m) => ({
                label: String(m.id || m.name || m),
                value: String(m.id || m.name || m),
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default Infrastructure;
