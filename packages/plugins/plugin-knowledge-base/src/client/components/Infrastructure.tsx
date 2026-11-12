// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '@nocobase/client-v2';
import { useTranslation } from 'react-i18next';
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
  Checkbox,
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

type VectorDatabaseRecord = {
  id: string;
  name: string;
  provider: string;
  connectParams?: Record<string, unknown> & {
    host?: string;
    port?: number;
    database?: string;
    tableName?: string;
    password?: string;
    apiKey?: string;
  };
};

type VectorDatabaseFormValues = {
  name: string;
  provider: string;
  password?: string;
  apiKey?: string;
  clearPassword?: boolean;
  clearApiKey?: boolean;
  [key: string]: unknown;
};

function getVectorDatabaseValues(formValues: VectorDatabaseFormValues) {
  const { name, provider, password, apiKey, clearPassword, clearApiKey, ...connectParams } = formValues;
  if (clearPassword) {
    connectParams.password = null;
  } else if (password && password !== '***') {
    connectParams.password = password;
  }
  if (clearApiKey) {
    connectParams.apiKey = null;
  } else if (apiKey && apiKey !== '***') {
    connectParams.apiKey = apiKey;
  }
  return { name, provider, connectParams };
}

function knownServerMessage(value: unknown, knownErrors: { source: string; localized: string }[], fallback: string) {
  const known = knownErrors.find(({ source, localized }) => value === source || value === localized);
  return known?.localized ?? fallback;
}

function safeServerError(error: unknown, knownErrors: { source: string; localized: string }[], fallback: string) {
  const response = error as { response?: { data?: { errors?: { message?: unknown }[] } } } | null;
  return knownServerMessage(response?.response?.data?.errors?.[0]?.message, knownErrors, fallback);
}

export const Infrastructure: React.FC = () => {
  const api = useApp().apiClient;
  const { t } = useTranslation('plugin-knowledge-base');
  const knownErrors = [
    'Provide a new credential or clear the saved credential when changing the connection destination',
    'Vector database storage location is in use; create a new vector database and migrate documents first',
    'Invalid vector store',
    'Connection test failed',
  ].map((source) => ({ source, localized: t(source) }));

  // ----- Vector Databases State -----
  const [vectorDatabases, setVectorDatabases] = useState<VectorDatabaseRecord[]>([]);
  const [vdLoading, setVdLoading] = useState(false);
  const [vdModalVisible, setVdModalVisible] = useState(false);
  const [vdEditingRecord, setVdEditingRecord] = useState<VectorDatabaseRecord | null>(null);
  const [vdTestResult, setVdTestResult] = useState<{ success?: boolean; error?: string } | null>(null);
  const [vdTesting, setVdTesting] = useState(false);
  const [vdForm] = Form.useForm<VectorDatabaseFormValues>();

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

  const fetchVectorDatabases = useCallback(async () => {
    setVdLoading(true);
    try {
      const res = await api.request({ url: 'aiVectorDatabase:list' });
      const records: VectorDatabaseRecord[] = res?.data?.data ?? [];
      setVectorDatabases(
        records.map((record) => {
          const connectParams = { ...record.connectParams };
          if (connectParams.password) connectParams.password = '***';
          if (connectParams.apiKey) connectParams.apiKey = '***';
          return { ...record, connectParams };
        }),
      );
    } catch {
      message.error('Failed to load vector databases');
    } finally {
      setVdLoading(false);
    }
  }, [api]);

  const fetchVectorStores = useCallback(async () => {
    setVsLoading(true);
    try {
      const res = await api.request({ url: 'aiVectorStore:list' });
      setVectorStores(res?.data?.data ?? []);
    } catch {
      message.error('Failed to load vector stores');
    } finally {
      setVsLoading(false);
    }
  }, [api]);

  const fetchLLMServices = useCallback(async () => {
    try {
      const res = await api.request({ url: 'ai:listLLMServices', params: { model: 'EMBEDDING' } });
      setLlmServices(res?.data?.data ?? []);
    } catch {
      // ignore
    }
  }, [api]);

  const fetchEmbeddingModels = async (llmServiceName: string) => {
    setModelsLoading(true);
    setEmbeddingModels([]);
    try {
      const res = await api.request({
        url: 'ai:listModels',
        params: { llmService: llmServiceName, model: 'EMBEDDING' },
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
  }, [fetchVectorDatabases, fetchVectorStores, fetchLLMServices]);

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

  const handleVdEdit = (record: VectorDatabaseRecord) => {
    setVdEditingRecord(record);
    setVdTestResult(null);
    vdForm.resetFields();
    const connectParams = { ...record.connectParams };
    delete connectParams.password;
    delete connectParams.apiKey;
    vdForm.setFieldsValue({
      name: record.name,
      provider: record.provider,
      ...connectParams,
    });
    setVdModalVisible(true);
  };

  const handleVdTest = async () => {
    setVdTesting(true);
    setVdTestResult(null);
    try {
      const formValues = await vdForm.validateFields();
      const { provider, connectParams } = getVectorDatabaseValues(formValues);
      const res = await api.request({
        url: 'aiVectorDatabase:test',
        method: 'post',
        data: { values: { ...(vdEditingRecord ? { id: vdEditingRecord.id } : {}), provider, connectParams } },
      });
      const result = res?.data?.data;
      setVdTestResult(
        result?.success
          ? { success: true }
          : { success: false, error: knownServerMessage(result?.error, knownErrors, t('Connection test failed')) },
      );
    } catch (error) {
      setVdTestResult({ success: false, error: safeServerError(error, knownErrors, t('Connection test failed')) });
    } finally {
      setVdTesting(false);
    }
  };

  const handleVdSave = async () => {
    try {
      const formValues = await vdForm.validateFields();
      const values = getVectorDatabaseValues(formValues);

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
    } catch (error) {
      message.error(safeServerError(error, knownErrors, 'Operation failed'));
    }
  };

  const handleVdDelete = async (id: string) => {
    try {
      await api.request({ url: 'aiVectorDatabase:destroy', method: 'post', params: { filterByTk: id } });
      message.success('Deleted successfully');
      fetchVectorDatabases();
    } catch (error) {
      message.error(safeServerError(error, knownErrors, 'Delete failed'));
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
    } catch (error) {
      message.error(safeServerError(error, knownErrors, 'Operation failed'));
    }
  };

  const handleVsDelete = async (id: string) => {
    try {
      await api.request({ url: 'aiVectorStore:destroy', method: 'post', params: { filterByTk: id } });
      message.success('Deleted successfully');
      fetchVectorStores();
    } catch (error) {
      message.error(safeServerError(error, knownErrors, 'Delete failed'));
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
        <Button type="primary" shape="round" icon={<PlusOutlined />} onClick={handleVdCreate}>
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
                style={{ borderRadius: 12, border: '1px solid #f0f0f0', boxShadow: '0 2px 8px rgba(0,0,0,0.02)' }}
                headStyle={{ borderBottom: '1px solid #f0f0f0' }}
                bodyStyle={{ padding: 20 }}
                title={
                  <Space>
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 8,
                        background: '#e6f4ff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#1890ff',
                      }}
                    >
                      <HddOutlined />
                    </div>
                    <Text strong>{vd.name}</Text>
                  </Space>
                }
                extra={
                  <Tag color="blue" style={{ borderRadius: 4 }}>
                    {vd.provider}
                  </Tag>
                }
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text type="secondary">Host</Text>
                    <Text strong>
                      {vd.connectParams?.host}:{vd.connectParams?.port}
                    </Text>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text type="secondary">Database</Text>
                    <Text strong>{vd.connectParams?.database}</Text>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text type="secondary">Table</Text>
                    <Text strong>{vd.connectParams?.tableName}</Text>
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
        <Button type="primary" shape="round" icon={<PlusOutlined />} onClick={handleVsCreate}>
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
                style={{ borderRadius: 12, border: '1px solid #f0f0f0', boxShadow: '0 2px 8px rgba(0,0,0,0.02)' }}
                headStyle={{ borderBottom: '1px solid #f0f0f0' }}
                bodyStyle={{ padding: 20 }}
                title={
                  <Space>
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 8,
                        background: '#f6ffed',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#52c41a',
                      }}
                    >
                      <DatabaseOutlined />
                    </div>
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Space size={8}>
                      <HddOutlined style={{ color: '#8c8c8c' }} />
                      <Text type="secondary">DB</Text>
                    </Space>
                    <Text strong ellipsis style={{ maxWidth: 160 }}>
                      {vs.vectorDatabase?.name || 'Unknown'}
                    </Text>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Space size={8}>
                      <ApiOutlined style={{ color: '#8c8c8c' }} />
                      <Text type="secondary">LLM</Text>
                    </Space>
                    <Text strong ellipsis style={{ maxWidth: 160 }}>
                      {llmServiceTitleMap[vs.llmService] || vs.llmService}
                    </Text>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Space size={8}>
                      <SettingOutlined style={{ color: '#8c8c8c' }} />
                      <Text type="secondary">Model</Text>
                    </Space>
                    <Text strong ellipsis style={{ maxWidth: 160 }}>
                      {vs.embeddingModel}
                    </Text>
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
    <div style={{ padding: 32, maxWidth: 1200, margin: '0 auto', minHeight: '100vh' }}>
      <div style={{ marginBottom: 24 }}>
        <Title level={3} style={{ margin: 0, marginBottom: 8 }}>
          Knowledge Base Infrastructure
        </Title>
        <Text type="secondary" style={{ fontSize: 15 }}>
          Manage the underlying infrastructure that powers your AI knowledge bases.
        </Text>
      </div>

      <Card
        bodyStyle={{ padding: 0 }}
        style={{
          borderRadius: 12,
          overflow: 'hidden',
          border: '1px solid #f0f0f0',
          boxShadow: '0 4px 16px rgba(0,0,0,0.03)',
        }}
      >
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
          <Form.Item name="provider" label="Provider" initialValue="pgvector">
            <Select
              options={[
                { label: 'PGVector', value: 'pgvector' },
                { label: 'Qdrant', value: 'qdrant' },
              ]}
            />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prevValues, currentValues) => prevValues.provider !== currentValues.provider}
          >
            {({ getFieldValue }) => {
              const provider = getFieldValue('provider');

              if (provider === 'qdrant') {
                return (
                  <>
                    <Form.Item name="url" label="Qdrant URL" rules={[{ required: true }]}>
                      <Input placeholder="http://qdrant:6333" />
                    </Form.Item>
                    <Form.Item
                      name="apiKey"
                      label="API Key"
                      extra={
                        vdEditingRecord?.connectParams?.apiKey
                          ? t('A credential is configured. Leave blank to keep it.')
                          : undefined
                      }
                    >
                      <Input.Password placeholder="Optional API Key" />
                    </Form.Item>
                    {vdEditingRecord?.connectParams?.apiKey && (
                      <Form.Item name="clearApiKey" valuePropName="checked">
                        <Checkbox>{t('Clear saved credential')}</Checkbox>
                      </Form.Item>
                    )}
                    <Form.Item name="collectionName" label="Collection Name" rules={[{ required: true }]}>
                      <Input placeholder="e.g. nocobase_vectors" />
                    </Form.Item>
                  </>
                );
              }

              return (
                <>
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
                      <Form.Item
                        name="password"
                        label="Password"
                        extra={
                          vdEditingRecord?.connectParams?.password
                            ? t('A credential is configured. Leave blank to keep it.')
                            : undefined
                        }
                      >
                        <Input.Password />
                      </Form.Item>
                      {vdEditingRecord?.connectParams?.password && (
                        <Form.Item name="clearPassword" valuePropName="checked">
                          <Checkbox>{t('Clear saved credential')}</Checkbox>
                        </Form.Item>
                      )}
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
                </>
              );
            }}
          </Form.Item>
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
