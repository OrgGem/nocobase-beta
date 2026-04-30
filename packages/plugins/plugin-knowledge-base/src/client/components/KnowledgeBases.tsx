/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAPIClient, useApp } from '@nocobase/client';
import {
  Button,
  Modal,
  Form,
  Input,
  Select,
  Switch,
  Space,
  message,
  Popconfirm,
  Tag,
  Upload,
  Tooltip,
  Typography,
  Empty,
  Spin,
  Tabs,
  Card,
  Row,
  Col,
  InputNumber,
  List,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  UploadOutlined,
  ReloadOutlined,
  BookOutlined,
  InboxOutlined,
  GlobalOutlined,
  TeamOutlined,
  LockOutlined,
  FileTextOutlined,
  SettingOutlined,
  MenuUnfoldOutlined,
  SearchOutlined,
} from '@ant-design/icons';

const { Text, Title } = Typography;
const { Dragger } = Upload;

const statusConfig: Record<string, { color: string; label: string }> = {
  pending: { color: 'default', label: 'Pending' },
  processing: { color: 'processing', label: 'Processing' },
  success: { color: 'success', label: 'Success' },
  failed: { color: 'error', label: 'Failed' },
};

const accessIcons: Record<string, React.ReactNode> = {
  PUBLIC: <GlobalOutlined style={{ color: '#52c41a' }} />,
  SHARED: <TeamOutlined style={{ color: '#fa8c16' }} />,
  BASIC: <LockOutlined style={{ color: '#1890ff' }} />,
};

const accessColors: Record<string, string> = {
  PUBLIC: 'green',
  SHARED: 'orange',
  BASIC: 'blue',
};

const accessLevelOptions = [
  { label: '🔒 Basic (Personal)', value: 'BASIC' },
  { label: '👥 Shared (Role-based)', value: 'SHARED' },
  { label: '🌐 Public (System-wide)', value: 'PUBLIC' },
];

export const KnowledgeBases: React.FC = () => {
  const api = useAPIClient();
  const app = useApp();
  const [loading, setLoading] = useState(false);
  const [knowledgeBases, setKnowledgeBases] = useState<any[]>([]);
  const [selectedKB, setSelectedKB] = useState<any | null>(null);

  // States
  const [searchText, setSearchText] = useState('');
  const [docsLoading, setDocsLoading] = useState(false);
  const [documents, setDocuments] = useState<any[]>([]);
  const [kbSearchQuery, setKbSearchQuery] = useState('');
  const [kbSearchLoading, setKbSearchLoading] = useState(false);
  const [kbSearchResults, setKbSearchResults] = useState<any[]>([]);
  const [kbSearchTopK, setKbSearchTopK] = useState(5);

  const [vectorStores, setVectorStores] = useState<any[]>([]);
  const [roleOptions, setRoleOptions] = useState<any[]>([]);
  const [availableModels, setAvailableModels] = useState<any[]>([]);

  // Forms
  const [textModalVisible, setTextModalVisible] = useState(false);
  const [textForm] = Form.useForm();

  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [createForm] = Form.useForm();
  const [cAccessLevel, setCAccessLevel] = useState('PUBLIC');
  const [cType, setCType] = useState('LOCAL');

  const [settingsForm] = Form.useForm();
  const [sAccessLevel, setSAccessLevel] = useState('PUBLIC');
  const [sType, setSType] = useState('LOCAL');

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await api.request({
        url: 'aiKnowledgeBase:list',
        params: { sort: ['-createdAt'], appends: ['documents'] },
      });
      const kbList = res?.data?.data ?? [];
      setKnowledgeBases(kbList);

      if (!selectedKB && kbList.length > 0) {
        setSelectedKB(kbList[0]);
      } else if (selectedKB) {
        // Update selected KB silently
        const updated = kbList.find((k: any) => k.id === selectedKB.id);
        if (updated) setSelectedKB(updated);
      }
    } catch {
      message.error('Failed to load knowledge bases');
    } finally {
      setLoading(false);
    }
  };

  const fetchDependencies = async () => {
    try {
      const vsRes = await api.request({ url: 'aiVectorStore:list' });
      setVectorStores(vsRes?.data?.data ?? []);
      const roleRes = await api.request({ url: 'roles:list' });
      setRoleOptions((roleRes?.data?.data ?? []).map((r: any) => ({ label: r.title || r.name, value: r.name })));
      // Load available embedding models from plugin-embed-web-client (if active)
      try {
        const modelRes = await api.request({ url: 'embedWebClient:listModels' });
        setAvailableModels(modelRes?.data?.data ?? []);
      } catch {
        /* plugin not active */
      }
    } catch {
      // ignore
    }
  };

  const fetchDocuments = useCallback(
    async (kbId: string) => {
      setDocsLoading(true);
      try {
        const res = await api.request({
          url: 'aiKnowledgeBaseDoc:list',
          params: { filter: { knowledgeBaseId: kbId }, sort: ['-createdAt'] },
        });
        setDocuments(res?.data?.data ?? []);
      } catch {
        message.error('Failed to load documents');
      } finally {
        setDocsLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    fetchData();
    fetchDependencies();
  }, []);

  useEffect(() => {
    if (selectedKB) {
      fetchDocuments(selectedKB.id);

      const formValues = { ...selectedKB };
      if (selectedKB.options) {
        Object.assign(formValues, selectedKB.options);
      }
      // embedModelId / embedMode are top-level fields on the KB record
      formValues.embedModelId = selectedKB.embedModelId ?? undefined;
      formValues.embedMode = selectedKB.embedMode ?? 'client';
      settingsForm.setFieldsValue(formValues);
      setSAccessLevel(selectedKB.accessLevel);
      setSType(selectedKB.type || 'LOCAL');
    }
  }, [selectedKB?.id, fetchDocuments]);

  // Create
  const handleCreate = () => {
    createForm.resetFields();
    createForm.setFieldsValue({ accessLevel: 'PUBLIC', enabled: true, type: 'LOCAL' });
    setCAccessLevel('PUBLIC');
    setCType('LOCAL');
    setCreateModalVisible(true);
  };

  const submitCreate = async () => {
    try {
      const formValues = await createForm.validateFields();
      const { ragApiUrl, ragApiKey, ragNamespace, ragTopK, ragScoreThreshold, embedModelId, embedMode, ...restValues } =
        formValues;

      const values: any = { ...restValues, options: {} };
      if (restValues.type === 'EXTERNAL_RAG') {
        values.options = { ragApiUrl, ragApiKey, ragNamespace, ragTopK, ragScoreThreshold };
      }
      if (restValues.type === 'WEB_CLIENT_EMBED') {
        values.embedModelId = embedModelId ?? null;
        values.embedMode = embedMode ?? 'client';
      }

      const res = await api.request({
        url: 'aiKnowledgeBase:create',
        method: 'post',
        data: { values },
      });
      message.success('Created successfully');
      setCreateModalVisible(false);
      fetchData();
      setSelectedKB(res.data.data);
    } catch {
      message.error('Create failed');
    }
  };

  // Settings Update
  const handleUpdateSettings = async () => {
    try {
      const formValues = await settingsForm.validateFields();
      if (!selectedKB) return;

      const { ragApiUrl, ragApiKey, ragNamespace, ragTopK, ragScoreThreshold, embedModelId, embedMode, ...restValues } =
        formValues;

      const values: any = { ...restValues, options: {} };
      if (restValues.type === 'EXTERNAL_RAG') {
        values.options = { ragApiUrl, ragApiKey, ragNamespace, ragTopK, ragScoreThreshold };
      }
      if (restValues.type === 'WEB_CLIENT_EMBED') {
        values.embedModelId = embedModelId ?? null;
        values.embedMode = embedMode ?? 'client';
      }

      await api.request({
        url: 'aiKnowledgeBase:update',
        method: 'post',
        params: { filterByTk: selectedKB.id },
        data: { values },
      });
      message.success('Settings updated successfully');
      fetchData();
    } catch {
      message.error('Update failed');
    }
  };

  const handleDeleteKB = async (id: string) => {
    try {
      await api.request({
        url: 'aiKnowledgeBase:destroy',
        method: 'post',
        params: { filterByTk: id },
      });
      message.success('Deleted successfully');
      if (selectedKB?.id === id) {
        setSelectedKB(null);
      }
      fetchData();
    } catch {
      message.error('Delete failed');
    }
  };

  // Document Handlers
  const handleFileUpload = (file: any, onSuccess: any, onError: any) => {
    if (!selectedKB) return;
    const formData = new FormData();
    formData.append('file', file);
    const storageParam = selectedKB.fileStorage ? `?storageRule=${encodeURIComponent(selectedKB.fileStorage)}` : '';
    api.axios
      .post(`aiFiles:create${storageParam}`, formData, { headers: { 'Content-Type': 'multipart/form-data' } })
      .then((res: any) => onSuccess?.(res.data, file))
      .catch((err: any) => onError?.(err));
  };

  const handleUploadChange = (info: any) => {
    if (info.file.status === 'done') {
      const attachment = info.file.response?.data;
      if (attachment && selectedKB) {
        api
          .request({
            url: 'aiKnowledgeBaseDoc:create',
            method: 'post',
            data: {
              values: {
                knowledgeBaseId: selectedKB.id,
                fileId: attachment.id,
                filename: attachment.filename || info.file.name,
                status: 'pending',
              },
            },
          })
          .then(() => {
            message.success(`"${info.file.name}" uploaded`);
            fetchDocuments(selectedKB.id);
          })
          .catch(() => {});
      }
    } else if (info.file.status === 'error') {
      message.error(`Upload failed: ${info.file.name}`);
    }
  };

  const handleAddTextDocument = async () => {
    try {
      const values = await textForm.validateFields();
      if (!selectedKB) return;
      await api.request({
        url: 'aiKnowledgeBaseDoc:create',
        method: 'post',
        data: {
          values: {
            knowledgeBaseId: selectedKB.id,
            filename: values.filename,
            textContent: values.textContent,
            status: 'pending',
          },
        },
      });
      message.success('Text document added');
      setTextModalVisible(false);
      textForm.resetFields();
      fetchDocuments(selectedKB.id);
    } catch {
      message.error('Failed to add text document');
    }
  };

  const handleDeleteDocument = async (docId: string) => {
    try {
      await api.request({
        url: 'aiKnowledgeBaseDoc:destroy',
        method: 'post',
        params: { filterByTk: docId },
      });
      message.success('Document deleted');
      if (selectedKB) fetchDocuments(selectedKB.id);
    } catch {
      message.error('Delete failed');
    }
  };

  const handleReprocess = async (docId: string) => {
    try {
      await api.request({
        url: 'aiKnowledgeBaseDoc:reprocess',
        method: 'post',
        params: { filterByTk: docId },
      });
      message.success('Reprocessing started');
      if (selectedKB) fetchDocuments(selectedKB.id);
    } catch {
      message.error('Reprocess failed');
    }
  };

  const handleKnowledgeSearch = async () => {
    if (!selectedKB || !kbSearchQuery.trim()) {
      message.warning('Enter a search query first');
      return;
    }

    setKbSearchLoading(true);
    try {
      const res = await api.request({
        url: 'aiKnowledgeBase:search',
        method: 'post',
        data: {
          values: {
            query: kbSearchQuery,
            knowledgeBaseIds: [selectedKB.id],
            topK: kbSearchTopK,
            candidateK: Math.max(kbSearchTopK * 4, 20),
            scoreThreshold: 0.3,
            rerank: true,
          },
        },
      });
      setKbSearchResults(res?.data?.data?.data ?? []);
    } catch {
      message.error('Search failed');
    } finally {
      setKbSearchLoading(false);
    }
  };

  // Renders
  const renderSidebar = () => {
    const filtered = knowledgeBases.filter((kb) => kb.name.toLowerCase().includes(searchText.toLowerCase()));

    return (
      <div
        style={{
          width: 280,
          borderRight: '1px solid #f0f0f0',
          display: 'flex',
          flexDirection: 'column',
          background: '#fafafa',
          height: '100%',
        }}
      >
        <div
          style={{
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            borderBottom: '1px solid #f0f0f0',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text strong style={{ fontSize: 16 }}>
              Knowledge Bases
            </Text>
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={handleCreate}>
              Add
            </Button>
          </div>
          <Input.Search
            placeholder="Filter knowledge bases..."
            allowClear
            onChange={(e) => setSearchText(e.target.value)}
          />
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading && filtered.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center' }}>
              <Spin />
            </div>
          ) : filtered.length === 0 ? (
            <Empty description="No knowledge bases found" style={{ marginTop: 24 }} />
          ) : (
            filtered.map((kb) => {
              const isActive = selectedKB?.id === kb.id;
              const docCount = kb.documents?.length || 0;
              const failedCount = kb.documents?.filter((d: any) => d.status === 'failed').length || 0;

              return (
                <div
                  key={kb.id}
                  onClick={() => setSelectedKB(kb)}
                  style={{
                    padding: '12px 16px',
                    cursor: 'pointer',
                    background: isActive ? '#e6f4ff' : 'transparent',
                    borderLeft: isActive ? '3px solid #1890ff' : '3px solid transparent',
                    borderBottom: '1px solid #f8f8f8',
                    transition: 'all 0.2s',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {accessIcons[kb.accessLevel || 'PUBLIC']}
                    <Text strong={isActive} style={{ flex: 1, fontSize: 14 }} ellipsis>
                      {kb.name}
                    </Text>
                  </div>
                  <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Tag color={accessColors[kb.accessLevel || 'PUBLIC']} style={{ border: 0 }}>
                      {kb.accessLevel || 'PUBLIC'}
                    </Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {docCount} docs {failedCount > 0 && <span style={{ color: '#ff4d4f' }}>• {failedCount} err</span>}
                    </Text>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  };

  const renderDocumentsTab = () => {
    if (selectedKB?.type === 'EXTERNAL_RAG') {
      return (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Empty description="External RAG Knowledge Base. Documents are managed by the external service." />
        </div>
      );
    }

    if (selectedKB?.type === 'WEB_CLIENT_EMBED') {
      // The WebClientDocumentUploader is provided by plugin-embed-web-client and
      // registered in the app component registry. Fall back to a hint if the plugin is not active.
      const WebClientUploader = app?.components?.['WebClientDocumentUploader'];
      if (WebClientUploader) {
        return <WebClientUploader knowledgeBaseId={selectedKB.id} onComplete={() => fetchDocuments(selectedKB.id)} />;
      }
      return (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Empty description="Enable the plugin-embed-web-client plugin to upload documents to this knowledge base." />
        </div>
      );
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
          <Dragger
            name="file"
            multiple
            showUploadList={false}
            accept=".txt,.md,.pdf,.doc,.docx,.ppt,.pptx,.csv,.json"
            customRequest={({ file, onSuccess, onError }) => handleFileUpload(file, onSuccess, onError)}
            onChange={handleUploadChange}
            style={{ flex: 1, padding: '24px 0', background: '#fafafa' }}
          >
            <p className="ant-upload-drag-icon" style={{ marginBottom: 8 }}>
              <InboxOutlined />
            </p>
            <p className="ant-upload-text" style={{ margin: 0, marginBottom: 8 }}>
              Drag files here or click to upload
            </p>
            <Space>
              <Button type="primary" size="small" icon={<UploadOutlined />}>
                Upload File
              </Button>
            </Space>
          </Dragger>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              width: 240,
              border: '1px dashed #d9d9d9',
              borderRadius: 8,
              background: '#fafafa',
              padding: 16,
              textAlign: 'center',
            }}
          >
            <FileTextOutlined style={{ fontSize: 32, color: '#1890ff', marginBottom: 12 }} />
            <Text style={{ marginBottom: 12 }}>Paste plain text content</Text>
            <div>
              <Button onClick={() => setTextModalVisible(true)} icon={<PlusOutlined />}>
                Paste Text
              </Button>
            </div>
          </div>
        </div>

        {docsLoading ? (
          <div style={{ padding: 48, textAlign: 'center' }}>
            <Spin />
          </div>
        ) : documents.length === 0 ? (
          <Empty description="No documents yet" />
        ) : (
          <Row gutter={[16, 16]}>
            {documents.map((doc) => {
              const cfg = statusConfig[doc.status] || { color: 'default', label: doc.status };
              const isProcessing = doc.status === 'processing';
              const fileDeleted = selectedKB.deleteSourceFile && !doc.fileId && !doc.textContent;
              const reprocessTip = isProcessing ? 'Processing...' : fileDeleted ? 'Source file deleted' : 'Reprocess';

              return (
                <Col span={8} key={doc.id}>
                  <Card
                    size="small"
                    hoverable
                    actions={[
                      <Tooltip title={reprocessTip} key="reprocess">
                        <Button
                          type="text"
                          icon={<ReloadOutlined />}
                          onClick={() => handleReprocess(doc.id)}
                          disabled={isProcessing || fileDeleted}
                        />
                      </Tooltip>,
                      <Popconfirm title="Delete document?" onConfirm={() => handleDeleteDocument(doc.id)} key="delete">
                        <Tooltip title="Delete">
                          <Button type="text" danger icon={<DeleteOutlined />} />
                        </Tooltip>
                      </Popconfirm>,
                    ]}
                  >
                    <Card.Meta
                      avatar={<FileTextOutlined style={{ fontSize: 24, color: '#8c8c8c' }} />}
                      title={
                        <Tooltip title={doc.filename}>
                          <Text ellipsis style={{ maxWidth: '100%' }}>
                            {doc.filename}
                          </Text>
                        </Tooltip>
                      }
                      description={
                        <Space direction="vertical" size={2} style={{ width: '100%' }}>
                          <Space style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                            <Tag color={cfg.color} style={{ margin: 0 }}>
                              {cfg.label}
                            </Tag>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              {doc.chunkCount || 0} chunks
                            </Text>
                          </Space>
                          {doc.error && doc.status === 'failed' && (
                            <Text type="danger" style={{ fontSize: 12, display: 'block', marginTop: 4 }} ellipsis>
                              {doc.error}
                            </Text>
                          )}
                        </Space>
                      }
                    />
                  </Card>
                </Col>
              );
            })}
          </Row>
        )}
      </div>
    );
  };

  const renderSearchTab = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <Input.Search
          value={kbSearchQuery}
          placeholder="Search this knowledge base..."
          enterButton={
            <Button type="primary" icon={<SearchOutlined />} loading={kbSearchLoading}>
              Search
            </Button>
          }
          allowClear
          onChange={(e) => setKbSearchQuery(e.target.value)}
          onSearch={handleKnowledgeSearch}
          style={{ maxWidth: 720 }}
        />
        <Space>
          <Text type="secondary">Top K</Text>
          <InputNumber min={1} max={20} value={kbSearchTopK} onChange={(value) => setKbSearchTopK(value || 5)} />
        </Space>
      </div>

      {kbSearchLoading ? (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Spin />
        </div>
      ) : kbSearchResults.length === 0 ? (
        <Empty description="No search results" />
      ) : (
        <List
          itemLayout="vertical"
          dataSource={kbSearchResults}
          renderItem={(item: any, index) => (
            <List.Item key={item.id ?? index}>
              <List.Item.Meta
                title={
                  <Space>
                    <Text strong>#{index + 1}</Text>
                    <Tag color="blue">rerank {Number(item.rerankScore ?? item.score ?? 0).toFixed(3)}</Tag>
                    <Tag>vector {Number(item.vectorScore ?? item.score ?? 0).toFixed(3)}</Tag>
                    {item.metadata?.source && <Text type="secondary">{item.metadata.source}</Text>}
                  </Space>
                }
                description={
                  <Typography.Paragraph ellipsis={{ rows: 4, expandable: true }} style={{ marginBottom: 0 }}>
                    {item.content}
                  </Typography.Paragraph>
                }
              />
            </List.Item>
          )}
        />
      )}
    </div>
  );

  const formFields = (
    formObj: any,
    currentType: string,
    currentAccessLevel: string,
    setCA: (v: string) => void,
    setCT: (v: string) => void,
  ) => (
    <>
      <Form.Item name="name" label="Name" rules={[{ required: true }]}>
        <Input />
      </Form.Item>

      <Row gutter={16}>
        <Col span={12}>
          <Form.Item name="type" label="Type" rules={[{ required: true }]}>
            <Select
              options={[
                { label: 'Local (Vector DB)', value: 'LOCAL' },
                { label: 'Readonly', value: 'READONLY' },
                { label: 'External (Linked)', value: 'EXTERNAL' },
                { label: 'External RAG API', value: 'EXTERNAL_RAG' },
                { label: 'Web Client Embedding', value: 'WEB_CLIENT_EMBED' },
              ]}
              onChange={setCT}
            />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item name="accessLevel" label="Access Level" rules={[{ required: true }]}>
            <Select options={accessLevelOptions} onChange={setCA} />
          </Form.Item>
        </Col>
      </Row>

      {currentAccessLevel === 'SHARED' && (
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name="allowedRoles" label="Allowed Roles (view)" rules={[{ required: true }]}>
              <Select mode="multiple" options={roleOptions} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="uploadRoles" label="Upload Roles (add docs)">
              <Select mode="multiple" options={roleOptions} />
            </Form.Item>
          </Col>
        </Row>
      )}

      {currentType === 'WEB_CLIENT_EMBED' && (
        <>
          <Form.Item>
            <div
              style={{
                background: '#e6f4ff',
                border: '1px solid #91caff',
                borderRadius: 6,
                padding: '10px 14px',
                color: '#0958d9',
              }}
            >
              Documents will be embedded using a local ONNX model — no API cost, no internet required.
            </div>
          </Form.Item>

          <Row gutter={16}>
            <Col span={14}>
              <Form.Item
                name="embedModelId"
                label="Embedding Model"
                extra="Leave empty to use the plugin default model"
              >
                <Select
                  allowClear
                  placeholder="Default (from plugin settings)"
                  options={availableModels.map((m: any) => ({
                    label: `${m.modelId} (${m.dimensions ?? '?'}-dim) [${m.source}]`,
                    value: m.modelId,
                    disabled: !m.baseFilesReady,
                  }))}
                />
              </Form.Item>
            </Col>
            <Col span={10}>
              <Form.Item
                name="embedMode"
                label="Embedding Mode"
                initialValue="client"
                extra={
                  formObj.getFieldValue?.('embedMode') === 'server'
                    ? 'Server computes embeddings (no browser download)'
                    : 'Browser computes embeddings (model loads in tab)'
                }
              >
                <Select
                  options={[
                    { label: '🖥️ In Browser (client)', value: 'client' },
                    { label: '⚡ On Server (server)', value: 'server' },
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>
        </>
      )}

      {currentType !== 'EXTERNAL_RAG' ? (
        <Form.Item
          name="vectorStoreId"
          label="Vector Store"
          rules={[{ required: currentType !== 'READONLY' && currentType !== 'EXTERNAL' }]}
        >
          <Select options={vectorStores.map((vs: any) => ({ label: vs.name, value: vs.id }))} />
        </Form.Item>
      ) : (
        <div style={{ background: '#f5f5f5', padding: 16, borderRadius: 8, marginBottom: 24 }}>
          <Text strong style={{ display: 'block', marginBottom: 16 }}>
            External RAG Configuration
          </Text>
          <Form.Item name="ragApiUrl" label="API URL" rules={[{ required: true, type: 'url' }]}>
            <Input placeholder="https://api.example.com/rag/search" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="ragApiKey" label="API Key">
                <Input.Password placeholder="Bearer token (optional)" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="ragNamespace" label="Namespace">
                <Input placeholder="Optional namespace" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="ragTopK" label="Top K">
                <Input type="number" placeholder="Default: 5" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="ragScoreThreshold" label="Score Threshold">
                <Input type="number" placeholder="Default: 0.0" step="0.1" max={1} min={0} />
              </Form.Item>
            </Col>
          </Row>
        </div>
      )}

      <Form.Item name="description" label="Description">
        <Input.TextArea autoSize={{ minRows: 3 }} />
      </Form.Item>

      <Row gutter={16}>
        <Col span={8}>
          <Form.Item name="enabled" label="Enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item name="deleteSourceFile" label="Delete source file" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item name="useDocpixie" label="Use DocPixie OCR" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Col>
      </Row>
    </>
  );

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)', overflow: 'hidden' }}>
      {renderSidebar()}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#fff', overflow: 'hidden' }}>
        {selectedKB ? (
          <>
            <div style={{ padding: '24px 32px 16px', borderBottom: '1px solid #f0f0f0' }}>
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}
              >
                <div>
                  <Title level={4} style={{ margin: 0, marginBottom: 4 }}>
                    {selectedKB.name}
                  </Title>
                  <Space>
                    <Tag>{selectedKB.type || 'LOCAL'}</Tag>
                    {selectedKB.vectorStore && <Tag icon={<SettingOutlined />}>{selectedKB.vectorStore.name}</Tag>}
                  </Space>
                </div>
                <Popconfirm title="Delete this knowledge base?" onConfirm={() => handleDeleteKB(selectedKB.id)}>
                  <Button danger ghost icon={<DeleteOutlined />}>
                    Delete
                  </Button>
                </Popconfirm>
              </div>
              <Text type="secondary" style={{ display: 'block', maxWidth: 800 }}>
                {selectedKB.description || 'No description provided.'}
              </Text>
            </div>

            <Tabs
              defaultActiveKey="documents"
              style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
              className="kb-detail-tabs"
              items={[
                {
                  key: 'documents',
                  label: 'Documents',
                  children: (
                    <div style={{ padding: '24px 32px', overflowY: 'auto', height: '100%' }}>
                      {renderDocumentsTab()}
                    </div>
                  ),
                },
                {
                  key: 'search',
                  label: 'Search',
                  children: (
                    <div style={{ padding: '24px 32px', overflowY: 'auto', height: '100%' }}>{renderSearchTab()}</div>
                  ),
                },
                {
                  key: 'settings',
                  label: 'Settings',
                  children: (
                    <div style={{ padding: '24px 32px', overflowY: 'auto', height: '100%', maxWidth: 800 }}>
                      <Form form={settingsForm} layout="vertical" onFinish={handleUpdateSettings}>
                        {formFields(settingsForm, sType, sAccessLevel, setSAccessLevel, setSType)}
                        <Form.Item>
                          <Button type="primary" htmlType="submit">
                            Save Changes
                          </Button>
                        </Form.Item>
                      </Form>
                    </div>
                  ),
                },
              ]}
            />
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty description="Select a knowledge base from the sidebar or create a new one" />
          </div>
        )}
      </div>

      <Modal
        title="Create Knowledge Base"
        open={createModalVisible}
        onOk={submitCreate}
        onCancel={() => setCreateModalVisible(false)}
        width={700}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical">
          {formFields(createForm, cType, cAccessLevel, setCAccessLevel, setCType)}
        </Form>
      </Modal>

      <Modal
        title="Add Text Document"
        open={textModalVisible}
        onOk={handleAddTextDocument}
        onCancel={() => setTextModalVisible(false)}
        width={600}
        destroyOnClose
      >
        <Form form={textForm} layout="vertical">
          <Form.Item name="filename" label="Document Name" rules={[{ required: true }]}>
            <Input placeholder="e.g. FAQ" />
          </Form.Item>
          <Form.Item name="textContent" label="Content" rules={[{ required: true }]}>
            <Input.TextArea autoSize={{ minRows: 6, maxRows: 16 }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default KnowledgeBases;
