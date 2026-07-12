import React, { useEffect, useMemo, useState } from 'react';
import { useFlowContext } from '@nocobase/flow-engine';
import {
  Alert,
  Button,
  Checkbox,
  Col,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { ReloadOutlined, SaveOutlined, SearchOutlined, SyncOutlined } from '@ant-design/icons';
import { useT } from '../locale';
import { getWrappedListPayload } from '../utils/api';

type Settings = {
  enabled: boolean;
  autoIndex: boolean;
  enableAiTool: boolean;
  parserStrategy: string;
  llmService?: string | null;
  indexModel?: string | null;
  retrieveModel?: string | null;
  pageIndexWorkspace: string;
  pageIndexPythonCommand: string;
  maxFileSizeMb: number;
  allowedExtnames: string[];
  concurrency: number;
  timeoutMs: number;
};

type LLMService = {
  llmService: string;
  llmServiceTitle: string;
  enabledModels: { label: string; value: string }[];
};

const DEFAULT_EXTENSIONS = [
  '.pdf',
  '.md',
  '.markdown',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.csv',
  '.tsv',
  '.html',
  '.htm',
  '.txt',
];

function statusTag(value?: string) {
  const color =
    value === 'indexed' || value === 'succeeded'
      ? 'green'
      : value === 'failed'
        ? 'red'
        : value === 'running'
          ? 'blue'
          : value === 'deleted' || value === 'cancelled'
            ? 'default'
            : 'gold';
  return <Tag color={color}>{value || '-'}</Tag>;
}

export function SettingsPage() {
  const ctx = useFlowContext();
  const t = useT();
  const [form] = Form.useForm<Settings>();
  const [loading, setLoading] = useState(false);
  const [overview, setOverview] = useState<Record<string, any> | null>(null);
  const [health, setHealth] = useState<Record<string, any> | null>(null);
  const [documents, setDocuments] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [services, setServices] = useState<LLMService[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);

  const selectedService = Form.useWatch('llmService', form);
  const selectedModels = useMemo(() => {
    return services.find((item) => item.llmService === selectedService)?.enabledModels || [];
  }, [selectedService, services]);

  const request = (config: Record<string, unknown>) => ctx.api.request(config);

  const loadSettings = async () => {
    const response = await request({ url: 'fileSearchSettings:get', method: 'get' });
    form.setFieldsValue(response.data?.data || response.data);
  };

  const loadOverview = async () => {
    const response = await request({ url: 'fileSearch:overview', method: 'get' });
    setOverview(response.data?.data || response.data);
  };

  const loadHealth = async () => {
    const response = await request({ url: 'fileSearchSettings:healthCheck', method: 'get' });
    setHealth(response.data?.data || response.data);
  };

  const loadTables = async () => {
    const [docsRes, jobsRes] = await Promise.all([
      request({ url: 'fileSearchDocuments:list', method: 'get', params: { pageSize: 50, sort: '-updatedAt' } }),
      request({ url: 'fileSearchJobs:list', method: 'get', params: { pageSize: 50, sort: '-updatedAt' } }),
    ]);
    setDocuments(getWrappedListPayload<any>(docsRes.data).rows);
    setJobs(getWrappedListPayload<any>(jobsRes.data).rows);
  };

  const loadLLMServices = async () => {
    const response = await request({ url: 'ai:listAllEnabledModels', method: 'get' });
    const rows = Array.isArray(response.data?.data) ? response.data.data : [];
    setServices(rows);
  };

  const reloadAll = async () => {
    setLoading(true);
    try {
      await Promise.all([loadSettings(), loadOverview(), loadHealth(), loadTables(), loadLLMServices()]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reloadAll();
    // The initial load should run once; the callbacks close over stable NocoBase context for this page instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    const values = await form.validateFields();
    await request({ url: 'fileSearchSettings:save', method: 'post', data: { values } });
    ctx.message.success(t('Saved successfully'));
    await reloadAll();
  };

  const retryJob = async (jobId: number) => {
    await request({ url: `fileSearch:retryJob/${jobId}`, method: 'post' });
    ctx.message.success(t('Job queued'));
    await reloadAll();
  };

  const reindexDocument = async (documentId: number) => {
    await request({ url: `fileSearch:reindexDocument/${documentId}`, method: 'post' });
    ctx.message.success(t('Document queued'));
    await reloadAll();
  };

  const scanSources = async () => {
    const response = await request({ url: 'fileSearch:scanSources', method: 'post', data: { values: { limit: 200 } } });
    const body = response.data?.data || response.data;
    ctx.message.success(t('Scan queued {{count}} documents', { count: body?.queued || 0 }));
    await reloadAll();
  };

  const runSearch = async () => {
    if (!query.trim()) return;
    const response = await request({
      url: 'fileSearch:search',
      method: 'post',
      data: { values: { query, topK: 10 } },
    });
    setResults(getWrappedListPayload<any>(response.data).rows);
  };

  const healthItems = [
    ['PageIndex', health?.pageIndex],
    ['LLM', health?.llm],
    ['Parser', health?.parser],
    ['MarkItDown', health?.markitdown],
  ];

  return (
    <div style={{ padding: 24, maxWidth: 1280 }}>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {t('File Search')}
        </Typography.Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={reloadAll} loading={loading}>
            {t('Refresh')}
          </Button>
          <Button type="primary" icon={<SaveOutlined />} onClick={save}>
            {t('Save')}
          </Button>
        </Space>
      </Space>

      <Tabs
        items={[
          {
            key: 'overview',
            label: t('Overview'),
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={16}>
                <Row gutter={16}>
                  <Col span={6}>
                    <Statistic title={t('Indexed')} value={overview?.documents?.indexed || 0} />
                  </Col>
                  <Col span={6}>
                    <Statistic title={t('Queued')} value={overview?.jobs?.queued || 0} />
                  </Col>
                  <Col span={6}>
                    <Statistic title={t('Running')} value={overview?.jobs?.running || 0} />
                  </Col>
                  <Col span={6}>
                    <Statistic
                      title={t('Failed')}
                      value={(overview?.documents?.failed || 0) + (overview?.jobs?.failed || 0)}
                    />
                  </Col>
                </Row>
                <Descriptions bordered column={1} size="small">
                  {healthItems.map(([label, item]) => (
                    <Descriptions.Item key={label as string} label={label}>
                      <Space>
                        <Tag color={item?.ok ? 'green' : 'red'}>{item?.ok ? t('OK') : t('Issue')}</Tag>
                        <Typography.Text>{item?.message || '-'}</Typography.Text>
                      </Space>
                    </Descriptions.Item>
                  ))}
                  <Descriptions.Item label={t('Worker')}>
                    {overview?.queue?.running ? t('Running') : t('Not running')} ({overview?.queue?.workerMode || '-'})
                  </Descriptions.Item>
                </Descriptions>
              </Space>
            ),
          },
          {
            key: 'runtime',
            label: t('Runtime'),
            children: (
              <Form form={form} layout="vertical">
                <Alert
                  type="info"
                  showIcon
                  message={t('PageIndex is installed through Cluster Manager worker or sandbox packages.')}
                  style={{ marginBottom: 16 }}
                />
                <Row gutter={16}>
                  <Col span={12}>
                    <Form.Item name="pageIndexPythonCommand" label={t('Python command')} rules={[{ required: true }]}>
                      <Input />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item name="pageIndexWorkspace" label={t('PageIndex workspace')} rules={[{ required: true }]}>
                      <Input />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item name="timeoutMs" label={t('Timeout milliseconds')}>
                      <InputNumber min={60000} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                </Row>
                <Descriptions bordered column={1} size="small">
                  <Descriptions.Item label={t('Required Python packages')}>
                    {(health?.requiredPythonPackages || []).map((pkg: string) => (
                      <Tag key={pkg}>{pkg}</Tag>
                    ))}
                  </Descriptions.Item>
                </Descriptions>
              </Form>
            ),
          },
          {
            key: 'llm',
            label: t('LLM'),
            children: (
              <Form form={form} layout="vertical">
                <Row gutter={16}>
                  <Col span={8}>
                    <Form.Item name="llmService" label={t('LLM service')}>
                      <Select
                        allowClear
                        options={services.map((service) => ({
                          label: service.llmServiceTitle || service.llmService,
                          value: service.llmService,
                        }))}
                      />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item name="indexModel" label={t('Index model')}>
                      <Select
                        allowClear
                        options={selectedModels.map((model) => ({ label: model.label, value: model.value }))}
                      />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item name="retrieveModel" label={t('Retrieve model')}>
                      <Select
                        allowClear
                        options={selectedModels.map((model) => ({ label: model.label, value: model.value }))}
                      />
                    </Form.Item>
                  </Col>
                </Row>
              </Form>
            ),
          },
          {
            key: 'indexing',
            label: t('Indexing'),
            children: (
              <Form form={form} layout="vertical">
                <Row gutter={16}>
                  <Col span={6}>
                    <Form.Item name="enabled" valuePropName="checked">
                      <Checkbox>{t('Enabled')}</Checkbox>
                    </Form.Item>
                  </Col>
                  <Col span={6}>
                    <Form.Item name="autoIndex" valuePropName="checked">
                      <Checkbox>{t('Auto index')}</Checkbox>
                    </Form.Item>
                  </Col>
                  <Col span={6}>
                    <Form.Item name="enableAiTool" valuePropName="checked">
                      <Checkbox>{t('Enable AI tool')}</Checkbox>
                    </Form.Item>
                  </Col>
                  <Col span={6}>
                    <Form.Item name="parserStrategy" label={t('Parser strategy')}>
                      <Select
                        options={[
                          { label: 'Document Parser', value: 'document-parser' },
                          { label: 'MarkItDown', value: 'markitdown' },
                          { label: 'Direct PDF/Markdown', value: 'direct' },
                        ]}
                      />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item name="allowedExtnames" label={t('Allowed extensions')}>
                      <Select mode="tags" options={DEFAULT_EXTENSIONS.map((value) => ({ label: value, value }))} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item name="maxFileSizeMb" label={t('Max file size MB')}>
                      <InputNumber min={1} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item name="concurrency" label={t('Concurrency')}>
                      <InputNumber min={1} max={8} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                </Row>
                <Button icon={<SyncOutlined />} onClick={scanSources}>
                  {t('Scan sources')}
                </Button>
              </Form>
            ),
          },
          {
            key: 'documents',
            label: t('Documents'),
            children: (
              <Table
                rowKey="id"
                dataSource={documents}
                pagination={{ pageSize: 10 }}
                columns={[
                  { title: t('File'), dataIndex: 'filename' },
                  { title: t('Collection'), dataIndex: 'fileCollection' },
                  { title: t('Status'), dataIndex: 'status', render: statusTag },
                  { title: t('Indexed at'), dataIndex: 'indexedAt' },
                  {
                    title: t('Actions'),
                    render: (_, row) => (
                      <Button icon={<SyncOutlined />} onClick={() => reindexDocument(row.id)}>
                        {t('Reindex')}
                      </Button>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: 'jobs',
            label: t('Jobs'),
            children: (
              <Table
                rowKey="id"
                dataSource={jobs}
                pagination={{ pageSize: 10 }}
                expandable={{
                  expandedRowRender: (row) => <Typography.Text>{row.errorMessage || '-'}</Typography.Text>,
                }}
                columns={[
                  { title: t('Document'), dataIndex: 'documentId' },
                  { title: t('Action'), dataIndex: 'action' },
                  { title: t('Status'), dataIndex: 'status', render: statusTag },
                  { title: t('Attempts'), dataIndex: 'attempts' },
                  { title: t('Worker'), dataIndex: 'workerId' },
                  {
                    title: t('Actions'),
                    render: (_, row) => (
                      <Button disabled={row.status === 'running'} onClick={() => retryJob(row.id)}>
                        {t('Retry')}
                      </Button>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: 'search',
            label: t('Search Preview'),
            children: (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Space.Compact style={{ width: '100%' }}>
                  <Input value={query} onChange={(event) => setQuery(event.target.value)} onPressEnter={runSearch} />
                  <Button type="primary" icon={<SearchOutlined />} onClick={runSearch}>
                    {t('Search')}
                  </Button>
                </Space.Compact>
                <Table
                  rowKey={(row) => `${row.documentId}-${row.nodeId || row.page || row.snippet}`}
                  dataSource={results}
                  pagination={false}
                  columns={[
                    { title: t('File'), dataIndex: 'filename' },
                    { title: t('Page'), dataIndex: 'page', width: 90 },
                    { title: t('Snippet'), dataIndex: 'snippet', ellipsis: true },
                  ]}
                />
              </Space>
            ),
          },
        ]}
      />
    </div>
  );
}

export default SettingsPage;
