/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * DocPixie Plugin — Client Settings Panel
 *
 * Provides:
 * - Core model/OCR provider configuration forms
 * - RAG Query Sandbox with rich KPI metrics and execution planning steps
 * - Real-time monitor/invocation logging viewer with detail modals
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Card,
  Switch,
  Button,
  Input,
  InputNumber,
  Form,
  message,
  Table,
  Tag,
  Space,
  Typography,
  Divider,
  Modal,
  Tabs,
  Select,
  Row,
  Col,
  Progress,
  List,
  Checkbox,
  Radio,
  Tooltip,
  Empty,
  Spin,
} from 'antd';
import {
  FileSearchOutlined,
  SettingOutlined,
  SlidersOutlined,
  PlayCircleOutlined,
  HistoryOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  DollarCircleOutlined,
  ClockCircleOutlined,
  ReloadOutlined,
  DeleteOutlined,
  EyeOutlined,
  FileTextOutlined,
  InfoCircleOutlined,
  InteractionOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;
const { Option } = Select;

const kpiCardStyle = {
  padding: '16px 8px',
  borderRadius: 12,
  background: 'linear-gradient(135deg, #ffffff 0%, #f6f9fc 100%)',
  border: '1px solid #eef3f8',
  boxShadow: '0 4px 12px rgba(13, 27, 62, 0.02)',
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 120,
};

export const DocPixieSettings: React.FC = () => {
  const api = useApp().apiClient;
  const [activeTab, setActiveTab] = useState('config');
  const [loading, setLoading] = useState(false);
  const [config, setConfig] = useState<any>(null);
  const [llmServices, setLlmServices] = useState<any[]>([]);
  const [documents, setDocuments] = useState<any[]>([]);

  // Sandbox State
  const [sandboxDocIds, setSandboxDocIds] = useState<number[]>([]);
  const [sandboxQuery, setSandboxQuery] = useState('');
  const [sandboxStrategy, setSandboxStrategy] = useState<string>('');
  const [sandboxLoading, setSandboxLoading] = useState(false);
  const [sandboxResult, setSandboxResult] = useState<any>(null);

  // Monitor State
  const [logs, setLogs] = useState<any[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [selectedLog, setSelectedLog] = useState<any>(null);

  const [form] = Form.useForm();

  // Load Config
  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.request({ url: 'docpixie:getConfig' });
      const currentConfig = data?.data || {};
      setConfig(currentConfig);
      form.setFieldsValue(currentConfig);
    } catch (e) {
      message.error('Failed to load DocPixie configuration');
    } finally {
      setLoading(false);
    }
  }, [api, form]);

  // Load LLM Services from NocoBase Central AI Manager
  const loadLlmServices = useCallback(async () => {
    try {
      const { data } = await api.request({ url: 'llmServices:list' });
      setLlmServices(data?.data || []);
    } catch (e) {
      console.warn('Failed to load LLM services, falling back to basic list');
      try {
        const { data } = await api.request({ url: 'ai:listLLMServices' });
        setLlmServices(data?.data || []);
      } catch (inner) {
        // ignore
      }
    }
  }, [api]);

  // Load Ready Documents for Sandbox Querying
  const loadDocuments = useCallback(async () => {
    try {
      const { data } = await api.request({
        url: 'docpixie:listDocuments',
        params: { status: 'ready', limit: 100 },
      });
      setDocuments(data?.data || []);
    } catch (e) {
      console.warn('Failed to load ready documents', e);
    }
  }, [api]);

  // Load Activity Invocations Logs
  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const { data } = await api.request({
        url: 'docpixie:listLogs',
        params: { limit: 100 },
      });
      setLogs(data?.data || []);
    } catch (e) {
      message.error('Failed to load RAG invocations log');
    } finally {
      setLogsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadConfig();
    loadLlmServices();
    loadDocuments();
    loadLogs();
  }, [loadConfig, loadLlmServices, loadDocuments, loadLogs]);

  // Save Config
  const handleSaveConfig = async (values: any) => {
    setLoading(true);
    try {
      await api.request({
        url: 'docpixie:updateConfig',
        method: 'post',
        data: values,
      });
      message.success('DocPixie settings saved successfully');
      loadConfig();
    } catch (e) {
      message.error('Failed to save configuration');
    } finally {
      setLoading(false);
    }
  };

  // Run Sandbox Query
  const handleRunSandboxQuery = async () => {
    if (!sandboxQuery.trim()) {
      message.warning('Please enter a query question');
      return;
    }
    setSandboxLoading(true);
    setSandboxResult(null);
    try {
      const { data } = await api.request({
        url: 'docpixie:query',
        method: 'post',
        data: {
          query: sandboxQuery,
          documentIds: sandboxDocIds.length > 0 ? sandboxDocIds : undefined,
          strategy: sandboxStrategy || undefined,
        },
      });
      setSandboxResult(data?.data || data);
      message.success('RAG analysis completed');
      loadLogs(); // Refresh monitor logs immediately
    } catch (e: any) {
      message.error(e.response?.data?.message || e.message || 'RAG query failed');
    } finally {
      setSandboxLoading(false);
    }
  };

  // Clear Activity Invocations Logs
  const handleClearLogs = () => {
    Modal.confirm({
      title: 'Clear RAG Invocations Log',
      content: 'Are you sure you want to delete all monitor log records? This action is permanent and cannot be undone.',
      okText: 'Clear All',
      okType: 'danger',
      onOk: async () => {
        try {
          await api.request({
            url: 'docpixie:clearLogs',
            method: 'post',
          });
          message.success('Monitor log cleared successfully');
          loadLogs();
        } catch (e) {
          message.error('Failed to clear logs');
        }
      },
    });
  };

  // Table Columns for Invocations Logs
  const logColumns = [
    {
      title: 'Time',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: (v: string) => (v ? new Date(v).toLocaleString() : 'N/A'),
    },
    {
      title: 'User',
      dataIndex: 'user',
      key: 'user',
      width: 120,
      render: (user: any) => user?.nickname || user?.username || <Text type="secondary">System/Guest</Text>,
    },
    {
      title: 'Query',
      dataIndex: 'query',
      key: 'query',
      ellipsis: true,
      render: (query: string) => (
        <Tooltip title={query}>
          <Text strong>{query}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'Strategy',
      dataIndex: 'strategy',
      key: 'strategy',
      width: 100,
      render: (v: string) => (
        <Tag color={v === 'hybrid' ? 'purple' : v === 'vision' ? 'orange' : 'blue'}>{v}</Tag>
      ),
    },
    {
      title: 'Confidence',
      dataIndex: 'confidence',
      key: 'confidence',
      width: 110,
      render: (v: number) => (
        <Tag color={v >= 0.7 ? 'success' : v >= 0.4 ? 'warning' : 'error'}>
          {Math.round((v || 0) * 100)}%
        </Tag>
      ),
    },
    {
      title: 'Cost',
      dataIndex: 'totalCost',
      key: 'totalCost',
      width: 100,
      render: (v: number) => <Text style={{ color: '#52c41a', fontWeight: 500 }}>${(v || 0).toFixed(4)}</Text>,
    },
    {
      title: 'Speed',
      dataIndex: 'processingTime',
      key: 'processingTime',
      width: 90,
      render: (v: number) => <Text>{(v || 0).toFixed(2)}s</Text>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => (
        <Tag color={status === 'success' ? 'green' : 'red'} icon={status === 'success' ? <CheckCircleOutlined /> : <CloseCircleOutlined />}>
          {status === 'success' ? 'Success' : 'Error'}
        </Tag>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 90,
      render: (_: any, record: any) => (
        <Button size="small" shape="round" icon={<EyeOutlined />} onClick={() => setSelectedLog(record)}>
          Details
        </Button>
      ),
    },
  ];

  // Document Map for log modal
  const readyDocMap = useMemo(() => {
    const map: Record<number, string> = {};
    documents.forEach((d) => {
      map[d.id] = d.name;
    });
    return map;
  }, [documents]);

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <Title level={3} style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            <FileSearchOutlined style={{ color: '#13c2c2' }} /> DocPixie Document AI Dashboard
          </Title>
          <Paragraph type="secondary" style={{ margin: 0, marginTop: 4 }}>
            Configure and monitor adaptive RAG Document QA agents, run sandbox test queries, and track LLM usage cost/performance.
          </Paragraph>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <Button icon={<ReloadOutlined />} onClick={() => { loadConfig(); loadLlmServices(); loadDocuments(); loadLogs(); }}>
            Sync Dashboard
          </Button>
        </div>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        size="large"
        tabBarStyle={{ marginBottom: 24 }}
        items={[
          {
            key: 'config',
            label: (
              <span>
                <SettingOutlined /> Settings & Sandbox
              </span>
            ),
            children: (
              <Row gutter={24}>
                {/* Configuration form column */}
                <Col span={10}>
                  <Card
                    title={
                      <span>
                        <SlidersOutlined style={{ color: '#1890ff', marginRight: 8 }} /> Ingestion & LLM Settings
                      </span>
                    }
                    bordered={false}
                    style={{ borderRadius: 12, boxShadow: '0 4px 16px rgba(0,0,0,0.02)', minHeight: 650 }}
                  >
                    {!llmServices.length && (
                      <div style={{ padding: '12px 16px', marginBottom: 20, background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 8 }}>
                        <Text type="warning">
                          <InfoCircleOutlined style={{ marginRight: 8 }} />
                          No registered LLM Services found in NocoBase. Please register your LLMs in <strong>AI Settings</strong> first.
                        </Text>
                      </div>
                    )}

                    <Form form={form} layout="vertical" onFinish={handleSaveConfig} disabled={loading}>
                      <Form.Item
                        name="llmServiceName"
                        label="Text LLM Service"
                        rules={[{ required: true, message: 'Please select a text model service' }]}
                        tooltip="Used for general cognitive planning, text OCR reference indexing, and answer synthesis."
                      >
                        <Select placeholder="Select text LLM service">
                          {llmServices.map((svc) => (
                            <Option key={svc.name} value={svc.name}>
                              {svc.title || svc.name} ({svc.provider})
                            </Option>
                          ))}
                        </Select>
                      </Form.Item>

                      <Form.Item
                        name="visionLlmServiceName"
                        label="Vision LLM Service"
                        tooltip="Used for multimodal page analysis, chart reading, and layout understanding. Falls back to text service if empty."
                      >
                        <Select placeholder="Select vision/multimodal LLM service (optional)" allowClear>
                          {llmServices.map((svc) => (
                            <Option key={svc.name} value={svc.name}>
                              {svc.title || svc.name} ({svc.provider})
                            </Option>
                          ))}
                        </Select>
                      </Form.Item>

                      <Divider style={{ margin: '16px 0' }} />

                      <Row gutter={16}>
                        <Col span={12}>
                          <Form.Item name="analysisStrategy" label="Default Strategy" initialValue="hybrid">
                            <Select>
                              <Option value="hybrid">Hybrid (Text + Vision)</Option>
                              <Option value="vision">Vision Only</Option>
                              <Option value="ocr_only">OCR Text Only</Option>
                            </Select>
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item name="ocrProvider" label="OCR Provider" initialValue="none">
                            <Select>
                              <Option value="none">None (Vision Only)</Option>
                              <Option value="external_api">External OCR API</Option>
                            </Select>
                          </Form.Item>
                        </Col>
                      </Row>

                      <Form.Item noStyle shouldUpdate={(prev, curr) => prev.ocrProvider !== curr.ocrProvider}>
                        {({ getFieldValue }) =>
                          getFieldValue('ocrProvider') === 'external_api' && (
                            <Card size="small" style={{ marginBottom: 16, background: '#fafafa', borderRadius: 8 }}>
                              <Form.Item
                                name="ocrApiEndpoint"
                                label="OCR API Endpoint"
                                rules={[{ required: true, message: 'API endpoint required' }]}
                              >
                                <Input placeholder="https://your-ocr-service.com/api" />
                              </Form.Item>
                              <Form.Item name="ocrApiKey" label="OCR API Key" style={{ marginBottom: 0 }}>
                                <Input.Password placeholder="Enter authorization token" />
                              </Form.Item>
                            </Card>
                          )
                        }
                      </Form.Item>

                      <Row gutter={16}>
                        <Col span={12}>
                          <Form.Item
                            name="maxPagesPerTask"
                            label="Max Pages Per Task"
                            rules={[{ required: true }]}
                            tooltip="Limits number of document pages analyzed inside a single sub-agent execution context."
                          >
                            <InputNumber min={1} max={30} style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item
                            name="maxTasksPerPlan"
                            label="Max Tasks Per Plan"
                            rules={[{ required: true }]}
                            tooltip="Caps the sub-tasks in adaptive planning loops to prevent run-away AI calls."
                          >
                            <InputNumber min={1} max={10} style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                      </Row>

                      <Form.Item style={{ marginTop: 24, marginBottom: 0 }}>
                        <Button type="primary" htmlType="submit" loading={loading} block>
                          Save Settings
                        </Button>
                      </Form.Item>
                    </Form>
                  </Card>
                </Col>

                {/* Sandbox testing column */}
                <Col span={14}>
                  <Card
                    title={
                      <span>
                        <PlayCircleOutlined style={{ color: '#52c41a', marginRight: 8 }} /> RAG Query Sandbox
                      </span>
                    }
                    bordered={false}
                    style={{ borderRadius: 12, boxShadow: '0 4px 16px rgba(0,0,0,0.02)', minHeight: 650 }}
                  >
                    <Paragraph type="secondary">
                      Select ready indexed documents and enter a prompt question to test the adaptive RAG agent on-the-fly.
                    </Paragraph>

                    <Row gutter={16} style={{ marginBottom: 16 }}>
                      <Col span={15}>
                        <div style={{ marginBottom: 6 }}><Text strong>Target Indexed Documents</Text></div>
                        <Select
                          mode="multiple"
                          style={{ width: '100%' }}
                          placeholder="Select specific document(s) (Leave empty to query all ready docs)"
                          value={sandboxDocIds}
                          onChange={setSandboxDocIds}
                          allowClear
                        >
                          {documents.map((d) => (
                            <Option key={d.id} value={d.id}>
                              {d.name} ({d.pageCount} pgs)
                            </Option>
                          ))}
                        </Select>
                      </Col>
                      <Col span={9}>
                        <div style={{ marginBottom: 6 }}><Text strong>Override Strategy</Text></div>
                        <Select
                          style={{ width: '100%' }}
                          placeholder="Use default config"
                          value={sandboxStrategy}
                          onChange={setSandboxStrategy}
                          allowClear
                        >
                          <Option value="hybrid">Hybrid (Text + Vision)</Option>
                          <Option value="vision">Vision Only</Option>
                          <Option value="ocr_only">OCR Text Only</Option>
                        </Select>
                      </Col>
                    </Row>

                    <div style={{ marginBottom: 6 }}><Text strong>Test Question</Text></div>
                    <TextArea
                      rows={3}
                      value={sandboxQuery}
                      onChange={(e) => setSandboxQuery(e.target.value)}
                      placeholder="e.g., What are the total revenues and net profits for Q3 as mentioned in the financials report? Detail the source pages."
                      style={{ borderRadius: 8, marginBottom: 16 }}
                    />

                    <Button
                      type="primary"
                      icon={<PlayCircleOutlined />}
                      onClick={handleRunSandboxQuery}
                      loading={sandboxLoading}
                      style={{ background: '#52c41a', borderColor: '#52c41a', borderRadius: 8 }}
                      block
                    >
                      Run RAG Agent Query
                    </Button>

                    <Divider style={{ margin: '20px 0' }} />

                    {/* Results Display */}
                    {sandboxLoading && (
                      <div style={{ padding: '48px 0', textAlign: 'center' }}>
                        <Spin size="large" tip="Adaptive planner running... Synthesizing chunks, classifying queries, and executing multimodal page analysis..." />
                      </div>
                    )}

                    {!sandboxLoading && !sandboxResult && (
                      <Empty description="Enter a query question and execute search to view RAG results" style={{ marginTop: 40 }} />
                    )}

                    {sandboxResult && (
                      <div>
                        {/* KPI Metrics Cards */}
                        <Row gutter={16} style={{ marginBottom: 20 }}>
                          <Col span={8}>
                            <div style={kpiCardStyle}>
                              <div style={{ marginBottom: 8 }}><Text type="secondary">Confidence Rating</Text></div>
                              <Progress
                                type="circle"
                                percent={Math.round((sandboxResult.confidence || 0) * 100)}
                                size={55}
                                strokeColor={{ '0%': '#ff4d4f', '50%': '#faad14', '100%': '#52c41a' }}
                              />
                            </div>
                          </Col>
                          <Col span={8}>
                            <div style={kpiCardStyle}>
                              <DollarCircleOutlined style={{ fontSize: 28, color: '#52c41a', marginBottom: 8 }} />
                              <div style={{ marginBottom: 4 }}><Text type="secondary">Estimated Cost</Text></div>
                              <Text strong style={{ fontSize: 16, color: '#3f8600' }}>
                                ${parseFloat(sandboxResult.totalCost || 0).toFixed(4)}
                              </Text>
                            </div>
                          </Col>
                          <Col span={8}>
                            <div style={kpiCardStyle}>
                              <ClockCircleOutlined style={{ fontSize: 28, color: '#1890ff', marginBottom: 8 }} />
                              <div style={{ marginBottom: 4 }}><Text type="secondary">Execution Speed</Text></div>
                              <Text strong style={{ fontSize: 16, color: '#096dd9' }}>
                                {parseFloat(sandboxResult.processingTime || 0).toFixed(2)}s
                              </Text>
                            </div>
                          </Col>
                        </Row>

                        {/* Text Answer */}
                        <div style={{ marginBottom: 16 }}>
                          <div style={{ marginBottom: 6 }}><Text strong>Synthesized Answer Findings</Text></div>
                          <div
                            style={{
                              background: '#f9fbfd',
                              border: '1px solid #e3edf7',
                              padding: '16px 20px',
                              borderRadius: 8,
                              fontSize: 14,
                              lineHeight: 1.6,
                              whiteSpace: 'pre-wrap',
                              maxHeight: 280,
                              overflowY: 'auto',
                            }}
                          >
                            {sandboxResult.answer}
                          </div>
                        </div>

                        {/* Subtasks Summary & Sources */}
                        <Row gutter={16}>
                          <Col span={12}>
                            <div style={{ marginBottom: 6 }}><Text strong>Adaptive Plan Timeline</Text></div>
                            <div style={{ maxHeight: 150, overflowY: 'auto', border: '1px solid #f0f0f0', borderRadius: 8, padding: 8 }}>
                              {sandboxResult.tasksSummary && sandboxResult.tasksSummary.length > 0 ? (
                                <List
                                  size="small"
                                  dataSource={sandboxResult.tasksSummary}
                                  renderItem={(t: any) => (
                                    <List.Item style={{ padding: '6px 4px' }}>
                                      <Space direction="vertical" size={2} style={{ width: '100%' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                                          <Text ellipsis style={{ maxWidth: 160 }} strong>{t.taskName || t.name}</Text>
                                          <Tag color={t.status === 'completed' ? 'success' : 'warning'}>{t.status}</Tag>
                                        </div>
                                        <Text type="secondary" style={{ fontSize: '12px' }}>
                                          Doc: {t.documentName} | Pages: {t.pagesAnalyzed?.join(', ') || 'none'}
                                        </Text>
                                      </Space>
                                    </List.Item>
                                  )}
                                />
                              ) : (
                                <Text type="secondary">Direct response logic. No sub-tasks planned.</Text>
                              )}
                            </div>
                          </Col>
                          <Col span={12}>
                            <div style={{ marginBottom: 6 }}><Text strong>Cited Reference Pages</Text></div>
                            <div style={{ maxHeight: 150, overflowY: 'auto', border: '1px solid #f0f0f0', borderRadius: 8, padding: 8 }}>
                              {sandboxResult.sourcePages && sandboxResult.sourcePages.length > 0 ? (
                                <List
                                  size="small"
                                  dataSource={sandboxResult.sourcePages}
                                  renderItem={(page: any) => (
                                    <List.Item style={{ padding: '4px' }}>
                                      <Space>
                                        <FileTextOutlined style={{ color: '#1890ff' }} />
                                        <Text strong ellipsis style={{ maxWidth: 150 }}>{page.documentName}</Text>
                                        <Tag color="cyan">Page {page.pageNumber}</Tag>
                                      </Space>
                                    </List.Item>
                                  )}
                                />
                              ) : (
                                <Text type="secondary">No citations referenced for this query.</Text>
                              )}
                            </div>
                          </Col>
                        </Row>
                      </div>
                    )}
                  </Card>
                </Col>
              </Row>
            ),
          },
          {
            key: 'monitor',
            label: (
              <span>
                <HistoryOutlined /> Invocations Monitor Log
              </span>
            ),
            children: (
              <Card
                title={
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>
                      <InteractionOutlined style={{ color: '#722ed1', marginRight: 8 }} /> Real-time DocPixie RAG Tool Invocations
                    </span>
                    <Space>
                      <Button icon={<ReloadOutlined />} onClick={loadLogs} loading={logsLoading}>
                        Refresh Logs
                      </Button>
                      <Button icon={<DeleteOutlined />} onClick={handleClearLogs} danger>
                        Clear History
                      </Button>
                    </Space>
                  </div>
                }
                bordered={false}
                style={{ borderRadius: 12, boxShadow: '0 4px 16px rgba(0,0,0,0.02)' }}
              >
                <Table
                  dataSource={logs}
                  columns={logColumns}
                  rowKey="id"
                  size="middle"
                  loading={logsLoading}
                  pagination={{ pageSize: 10 }}
                />
              </Card>
            ),
          },
        ]}
      />

      {/* Log detail Modal */}
      <Modal
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <FileTextOutlined style={{ color: '#1890ff' }} /> RAG Invocations Details
          </span>
        }
        open={!!selectedLog}
        onCancel={() => setSelectedLog(null)}
        footer={[
          <Button key="close" type="primary" onClick={() => setSelectedLog(null)}>
            Close
          </Button>,
        ]}
        width={850}
        destroyOnClose
      >
        {selectedLog && (
          <div style={{ padding: '10px 0' }}>
            <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
              <Col span={6}>
                <Text type="secondary">Timestamp</Text>
                <div style={{ marginTop: 4 }}><Text strong>{new Date(selectedLog.createdAt).toLocaleString()}</Text></div>
              </Col>
              <Col span={6}>
                <Text type="secondary">Caller</Text>
                <div style={{ marginTop: 4 }}>
                  <Text strong>{selectedLog.user?.nickname || selectedLog.user?.username || 'System/Guest'}</Text>
                </div>
              </Col>
              <Col span={4}>
                <Text type="secondary">Cost (USD)</Text>
                <div style={{ marginTop: 4 }}><Text strong style={{ color: '#52c41a' }}>${parseFloat(selectedLog.totalCost || 0).toFixed(4)}</Text></div>
              </Col>
              <Col span={4}>
                <Text type="secondary">Duration</Text>
                <div style={{ marginTop: 4 }}><Text strong>{parseFloat(selectedLog.processingTime || 0).toFixed(2)}s</Text></div>
              </Col>
              <Col span={4}>
                <Text type="secondary">Confidence</Text>
                <div style={{ marginTop: 4 }}>
                  <Tag color={selectedLog.confidence >= 0.7 ? 'success' : selectedLog.confidence >= 0.4 ? 'warning' : 'error'}>
                    {Math.round((selectedLog.confidence || 0) * 100)}%
                  </Tag>
                </div>
              </Col>
            </Row>

            <Divider style={{ margin: '12px 0' }} />

            <div style={{ marginBottom: 16 }}>
              <Text type="secondary">RAG Input Query</Text>
              <div style={{ background: '#fafafa', padding: 12, borderRadius: 8, marginTop: 6, fontWeight: 500 }}>
                {selectedLog.query}
              </div>
            </div>

            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={12}>
                <Text type="secondary">Analysis Strategy</Text>
                <div style={{ marginTop: 4 }}>
                  <Tag color={selectedLog.strategy === 'hybrid' ? 'purple' : selectedLog.strategy === 'vision' ? 'orange' : 'blue'}>
                    {selectedLog.strategy}
                  </Tag>
                </div>
              </Col>
              <Col span={12}>
                <Text type="secondary">Target Documents</Text>
                <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {Array.isArray(selectedLog.documentIds) && selectedLog.documentIds.length > 0 ? (
                    selectedLog.documentIds.map((id: number) => (
                      <Tag key={id} color="cyan">{readyDocMap[id] || `Document #${id}`}</Tag>
                    ))
                  ) : (
                    <Text type="secondary">All ready documents</Text>
                  )}
                </div>
              </Col>
            </Row>

            <Divider style={{ margin: '12px 0' }} />

            {selectedLog.status === 'success' ? (
              <div>
                <Text type="secondary">Synthesized Output Findings</Text>
                <div
                  style={{
                    background: '#f9fbfd',
                    border: '1px solid #e3edf7',
                    padding: '16px 20px',
                    borderRadius: 8,
                    fontSize: 14,
                    lineHeight: 1.6,
                    whiteSpace: 'pre-wrap',
                    maxHeight: 250,
                    overflowY: 'auto',
                    marginTop: 6,
                  }}
                >
                  {selectedLog.answer}
                </div>
              </div>
            ) : (
              <div>
                <Text type="secondary">
                  <WarningOutlined style={{ color: '#ff4d4f', marginRight: 4 }} /> Execution Stack Trace Error
                </Text>
                <div
                  style={{
                    background: '#fff2f0',
                    border: '1px solid #ffccc7',
                    padding: 12,
                    borderRadius: 8,
                    color: '#ff4d4f',
                    fontFamily: 'monospace',
                    fontSize: 12,
                    whiteSpace: 'pre-wrap',
                    maxHeight: 250,
                    overflow: 'auto',
                    marginTop: 6,
                  }}
                >
                  {selectedLog.error || 'Unknown execution error'}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
};



// Plugin entry point for NocoBase PluginManager
import { Plugin } from '@nocobase/client-v2';

export class PluginDocPixieClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add('docpixie', {
      title: 'DocPixie Document AI',
      icon: 'FileSearchOutlined',
      Component: DocPixieSettings,
      aclSnippet: 'pm.docpixie',
    });
  }
}

export default PluginDocPixieClient;
