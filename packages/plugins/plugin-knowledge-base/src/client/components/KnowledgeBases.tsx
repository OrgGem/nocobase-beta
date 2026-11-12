// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '@nocobase/client-v2';
import { useTranslation } from 'react-i18next';
import type { UploadProps } from 'antd';
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
  Row,
  Col,
  InputNumber,
  List,
  Table,
  Card,
  Layout,
  Divider,
  Checkbox,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  ReloadOutlined,
  InboxOutlined,
  GlobalOutlined,
  TeamOutlined,
  LockOutlined,
  FileTextOutlined,
  SettingOutlined,
  SearchOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
  SyncOutlined,
  BookOutlined,
  LikeOutlined,
  DislikeOutlined,
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
  { label: 'Personal', value: 'BASIC' },
  { label: 'Role-based shared', value: 'SHARED' },
  { label: 'Common knowledge', value: 'PUBLIC' },
];

const agentAccessOptions = [
  { label: 'Inherit from user', value: 'inherit' },
  { label: 'Explicit agents only', value: 'explicit' },
  { label: 'No agent access', value: 'none' },
];

const kbTypeConfig: Record<string, { color: string; label: string }> = {
  LOCAL: { color: 'blue', label: 'Local' },
  READONLY: { color: 'default', label: 'Readonly' },
  EXTERNAL: { color: 'purple', label: 'External' },
  EXTERNAL_RAG: { color: 'cyan', label: 'External RAG' },
};

const statusFilters = [
  { label: 'All', value: 'all' },
  { label: 'Failed', value: 'failed' },
  { label: 'Processing', value: 'processing' },
  { label: 'Pending', value: 'pending' },
  { label: 'Ready', value: 'success' },
];

function getDocumentStats(docs: any[]) {
  return docs.reduce(
    (stats, doc) => {
      stats.total += 1;
      stats[doc.status] = (stats[doc.status] || 0) + 1;
      return stats;
    },
    { total: 0, pending: 0, processing: 0, success: 0, failed: 0 } as Record<string, number>,
  );
}

function formatDate(value?: string) {
  if (!value) {
    return '-';
  }
  return new Date(value).toLocaleString();
}

type KnowledgeBaseRecord = {
  id: string;
  name: string;
  type: string;
  accessLevel: string;
  enabled?: boolean;
  deleteSourceFile?: boolean;
  description?: string;
  fileStorage?: string;
  options?: Record<string, unknown> & { ragApiKey?: string; hasRagApiKey?: boolean };
  [key: string]: unknown;
};

function sanitizeKnowledgeBase(record: KnowledgeBaseRecord): KnowledgeBaseRecord {
  if (!record.options) return record;
  const { ragApiKey, ...options } = record.options;
  return { ...record, options: { ...options, hasRagApiKey: options.hasRagApiKey ?? Boolean(ragApiKey) } };
}

function safeServerError(error: unknown, knownErrors: { source: string; localized: string }[], fallback: string) {
  const response = error as { response?: { data?: { errors?: { message?: unknown }[] } } } | null;
  const serverMessage = response?.response?.data?.errors?.[0]?.message;
  const known = knownErrors.find(({ source, localized }) => serverMessage === source || serverMessage === localized);
  return known?.localized ?? fallback;
}

export const KnowledgeBases: React.FC = () => {
  const api = useApp().apiClient;
  const { t } = useTranslation('plugin-knowledge-base');
  const knownErrors = [
    'Provide a new credential or clear the saved credential when changing the connection destination',
    'Vector database storage location is in use; create a new vector database and migrate documents first',
    'Invalid vector store',
    'Only administrators can configure External RAG providers that forward LLM credentials.',
  ].map((source) => ({ source, localized: t(source) }));
  const [loading, setLoading] = useState(false);
  const [knowledgeBases, setKnowledgeBases] = useState<any[]>([]);
  const [selectedKB, setSelectedKB] = useState<KnowledgeBaseRecord | null>(null);
  const selectedKBRef = React.useRef<KnowledgeBaseRecord | null>(null);
  const kbScopeRef = React.useRef(0);
  const documentsRequestRef = React.useRef(0);
  const knowledgeBasesRequestRef = React.useRef(0);
  const searchRequestRef = React.useRef(0);

  // States
  const [searchText, setSearchText] = useState('');
  const [sidebarTypeFilter, setSidebarTypeFilter] = useState<string>('all');
  const [docStatusFilter, setDocStatusFilter] = useState<string>('all');
  const [docsLoading, setDocsLoading] = useState(false);
  const [documents, setDocuments] = useState<any[]>([]);
  const [documentSelection, setDocumentSelection] = useState<{ scope: number; ids: React.Key[] }>({
    scope: 0,
    ids: [],
  });
  const [kbSearchQuery, setKbSearchQuery] = useState('');
  const [kbSearchLoading, setKbSearchLoading] = useState(false);
  const [kbSearchResults, setKbSearchResults] = useState<any[]>([]);
  const [kbSearchTopK, setKbSearchTopK] = useState(5);

  const [vectorStores, setVectorStores] = useState<any[]>([]);
  const [llmServices, setLlmServices] = useState<any[]>([]);
  const [roleOptions, setRoleOptions] = useState<any[]>([]);
  const [agentOptions, setAgentOptions] = useState<any[]>([]);

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
  const knowledgeBasesPageRef = React.useRef<HTMLDivElement>(null);
  const documentTableViewportRef = React.useRef<HTMLDivElement>(null);
  const [knowledgeBasesPageHeight, setKnowledgeBasesPageHeight] = useState<number>();
  const [documentTableScrollY, setDocumentTableScrollY] = useState(160);

  const selectKnowledgeBase = useCallback(
    (kb: KnowledgeBaseRecord | null) => {
      if (selectedKBRef.current?.id !== kb?.id) {
        kbScopeRef.current += 1;
        documentsRequestRef.current += 1;
        searchRequestRef.current += 1;
        setDocuments([]);
        setDocumentSelection({ scope: kbScopeRef.current, ids: [] });
        setDocStatusFilter('all');
        setDocsLoading(false);
        setKbSearchQuery('');
        setKbSearchResults([]);
        setKbSearchLoading(false);
        setTextModalVisible(false);
        textForm.resetFields();
        settingsForm.resetFields();
      }
      selectedKBRef.current = kb;
      setSelectedKB(kb);
    },
    [settingsForm, textForm],
  );

  useEffect(() => {
    return () => {
      kbScopeRef.current += 1;
      documentsRequestRef.current += 1;
      knowledgeBasesRequestRef.current += 1;
      searchRequestRef.current += 1;
    };
  }, []);

  const documentStats = React.useMemo(() => getDocumentStats(documents), [documents]);
  const selectedDocIds = documentSelection.scope === kbScopeRef.current ? documentSelection.ids : [];
  const filteredDocuments = React.useMemo(() => {
    if (docStatusFilter === 'all') {
      return documents;
    }
    return documents.filter((doc) => doc.status === docStatusFilter);
  }, [docStatusFilter, documents]);
  const selectedTypeConfig = kbTypeConfig[selectedKB?.type || 'LOCAL'] || kbTypeConfig.LOCAL;
  const selectedKBId = selectedKB?.id;
  const currentScope = kbScopeRef.current;

  useEffect(() => {
    const page = knowledgeBasesPageRef.current;
    if (!page || typeof window === 'undefined') {
      return;
    }

    const updatePageHeight = () => {
      const availableHeight = Math.floor(window.innerHeight - page.getBoundingClientRect().top);
      if (availableHeight > 0) {
        setKnowledgeBasesPageHeight(availableHeight);
      }
    };

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePageHeight);
    if (page.parentElement) {
      observer?.observe(page.parentElement);
    }
    window.addEventListener('resize', updatePageHeight);
    updatePageHeight();

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updatePageHeight);
    };
  }, []);

  useEffect(() => {
    const viewport = documentTableViewportRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') {
      return;
    }

    const updateTableHeight = () => {
      const availableHeight = Math.floor(viewport.getBoundingClientRect().height);
      if (availableHeight > 0) {
        // Reserve room for the table header and compact pagination controls.
        setDocumentTableScrollY(Math.max(120, availableHeight - 96));
      }
    };

    const observer = new ResizeObserver(updateTableHeight);
    observer.observe(viewport);
    updateTableHeight();

    return () => observer.disconnect();
  }, [selectedKB?.id]);

  const fetchData = useCallback(async () => {
    const scope = kbScopeRef.current;
    const requestId = ++knowledgeBasesRequestRef.current;
    setLoading(true);
    try {
      const res = await api.request({
        url: 'aiKnowledgeBase:list',
        params: { sort: ['-createdAt'], appends: ['documents'] },
      });
      const kbList: KnowledgeBaseRecord[] = (res?.data?.data ?? []).map(sanitizeKnowledgeBase);
      if (requestId !== knowledgeBasesRequestRef.current) return;
      setKnowledgeBases(kbList);
      if (scope === kbScopeRef.current) {
        const current = selectedKBRef.current;
        selectKnowledgeBase(current ? kbList.find((kb) => kb.id === current.id) ?? current : kbList[0] ?? null);
      }
    } catch {
      if (requestId === knowledgeBasesRequestRef.current) message.error('Failed to load knowledge bases');
    } finally {
      if (requestId === knowledgeBasesRequestRef.current) setLoading(false);
    }
  }, [api, selectKnowledgeBase]);

  const fetchDependencies = useCallback(async () => {
    try {
      const vsRes = await api.request({ url: 'aiVectorStore:list' });
      setVectorStores(vsRes?.data?.data ?? []);
      const llmRes = await api.request({ url: 'ai:listLLMServices' });
      setLlmServices(llmRes?.data?.data ?? []);
      const roleRes = await api.request({ url: 'roles:list' });
      setRoleOptions((roleRes?.data?.data ?? []).map((r: any) => ({ label: r.title || r.name, value: r.name })));
      try {
        const agentRes = await api.request({ url: 'aiEmployees:list', params: { filter: { enabled: true } } });
        setAgentOptions(
          (agentRes?.data?.data ?? []).map((a: any) => ({
            label: a.nickname ? `${a.nickname} (${a.username})` : a.username,
            value: a.username,
          })),
        );
      } catch {
        // ignore — aiEmployees may be unavailable if plugin-ai is not loaded
      }
    } catch {
      // ignore
    }
  }, [api]);

  const fetchDocuments = useCallback(
    async (kbId: string) => {
      if (selectedKBRef.current?.id !== kbId) return;
      const scope = kbScopeRef.current;
      const requestId = ++documentsRequestRef.current;
      setDocsLoading(true);
      try {
        const res = await api.request({
          url: 'aiKnowledgeBaseDoc:list',
          params: { filter: { knowledgeBaseId: kbId }, sort: ['-createdAt'] },
        });
        if (scope === kbScopeRef.current && requestId === documentsRequestRef.current) {
          setDocuments(res?.data?.data ?? []);
        }
      } catch {
        if (scope === kbScopeRef.current && requestId === documentsRequestRef.current) {
          message.error('Failed to load documents');
        }
      } finally {
        if (scope === kbScopeRef.current && requestId === documentsRequestRef.current) setDocsLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    fetchData();
    fetchDependencies();
  }, [fetchData, fetchDependencies]);

  useEffect(() => {
    settingsForm.resetFields();
    const current = selectedKBRef.current;
    if (current && current.id === selectedKBId) {
      fetchDocuments(current.id);
      const { options, ...formValues } = current;
      const safeOptions = { ...options };
      delete safeOptions.ragApiKey;
      delete safeOptions.hasRagApiKey;
      settingsForm.setFieldsValue({ ...formValues, ...safeOptions });
      setSAccessLevel(current.accessLevel);
      setSType(current.type || 'LOCAL');
    }
  }, [selectedKBId, fetchDocuments, settingsForm]);

  // Create
  const handleCreate = () => {
    createForm.resetFields();
    createForm.setFieldsValue({
      accessLevel: 'PUBLIC',
      enabled: true,
      type: 'LOCAL',
      ragProvider: 'openai-compatible',
      ragQueryPrefix: 'query: ',
      ragPassagePrefix: 'passage: ',
    });
    setCAccessLevel('PUBLIC');
    setCType('LOCAL');
    setCreateModalVisible(true);
  };

  const submitCreate = async () => {
    const scope = kbScopeRef.current;
    try {
      const formValues = await createForm.validateFields();
      const {
        ragProvider,
        ragApiUrl,
        ragApiKey,
        ragNamespace,
        ragTopK,
        ragScoreThreshold,
        ragEmbeddingLlmService,
        ragEmbeddingModel,
        ragQueryPrefix,
        ragPassagePrefix,
        ...restValues
      } = formValues;

      const values: Record<string, unknown> = { ...restValues, options: {} };
      if (restValues.type === 'EXTERNAL_RAG') {
        values.options = {
          ragProvider,
          ragApiUrl,
          ...(ragApiKey && ragApiKey !== '***' ? { ragApiKey } : {}),
          ragNamespace,
          ragTopK,
          ragScoreThreshold,
          ragEmbeddingLlmService,
          ragEmbeddingModel,
          ragQueryPrefix,
          ragPassagePrefix,
        };
      }
      const res = await api.request({
        url: 'aiKnowledgeBase:create',
        method: 'post',
        data: { values },
      });
      message.success('Created successfully');
      setCreateModalVisible(false);
      if (scope === kbScopeRef.current) selectKnowledgeBase(sanitizeKnowledgeBase(res.data.data));
      fetchData();
    } catch (error) {
      message.error(safeServerError(error, knownErrors, 'Create failed'));
    }
  };

  // Settings Update
  const handleUpdateSettings = async (kbId: string, scope: number, formValues: Record<string, unknown>) => {
    if (scope !== kbScopeRef.current || selectedKBRef.current?.id !== kbId) return;
    try {
      const {
        ragProvider,
        ragApiUrl,
        ragApiKey,
        clearRagApiKey,
        ragNamespace,
        ragTopK,
        ragScoreThreshold,
        ragEmbeddingLlmService,
        ragEmbeddingModel,
        ragQueryPrefix,
        ragPassagePrefix,
        ...restValues
      } = formValues;

      const values: Record<string, unknown> = { ...restValues, options: {} };
      if (restValues.type === 'EXTERNAL_RAG') {
        values.options = {
          ragProvider,
          ragApiUrl,
          ...(clearRagApiKey ? { ragApiKey: null } : ragApiKey && ragApiKey !== '***' ? { ragApiKey } : {}),
          ragNamespace,
          ragTopK,
          ragScoreThreshold,
          ragEmbeddingLlmService,
          ragEmbeddingModel,
          ragQueryPrefix,
          ragPassagePrefix,
        };
      }
      await api.request({
        url: 'aiKnowledgeBase:update',
        method: 'post',
        params: { filterByTk: kbId },
        data: { values },
      });
      if (scope !== kbScopeRef.current) return;
      settingsForm.setFieldsValue({ ragApiKey: undefined, clearRagApiKey: false });
      message.success('Settings updated successfully');
      fetchData();
    } catch (error) {
      if (scope === kbScopeRef.current) message.error(safeServerError(error, knownErrors, 'Update failed'));
    }
  };

  const handleDeleteKB = async (id: string) => {
    const scope = kbScopeRef.current;
    try {
      await api.request({
        url: 'aiKnowledgeBase:destroy',
        method: 'post',
        params: { filterByTk: id },
      });
      message.success('Deleted successfully');
      if (scope === kbScopeRef.current && selectedKBRef.current?.id === id) {
        selectKnowledgeBase(null);
      }
      fetchData();
    } catch {
      message.error('Delete failed');
    }
  };

  // Document Handlers
  const handleFileUpload: NonNullable<UploadProps['customRequest']> = async ({ file, onSuccess, onError }) => {
    if (!selectedKB) return;
    const kbId = selectedKB.id;
    const scope = kbScopeRef.current;
    const storageParam = selectedKB.fileStorage ? `?storageRule=${encodeURIComponent(selectedKB.fileStorage)}` : '';
    const filename = typeof file === 'string' ? file : 'name' in file ? file.name : 'file';
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await api.axios.post(`aiFiles:create${storageParam}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const attachment = res?.data?.data;
      if (!attachment?.id) throw new Error('Upload failed');
      await api.request({
        url: 'aiKnowledgeBaseDoc:create',
        method: 'post',
        data: {
          values: {
            knowledgeBaseId: kbId,
            fileId: attachment.id,
            filename: attachment.filename || filename,
            status: 'pending',
          },
        },
      });
      onSuccess?.(res.data);
      if (scope === kbScopeRef.current) {
        message.success(`"${filename}" uploaded`);
        fetchDocuments(kbId);
      }
    } catch {
      onError?.(new Error('Upload failed'));
      if (scope === kbScopeRef.current) message.error(`Upload failed: ${filename}`);
    }
  };

  const handleAddTextDocument = async () => {
    const kbId = selectedKBRef.current?.id;
    const scope = kbScopeRef.current;
    if (!kbId) return;
    try {
      const values = await textForm.validateFields();
      if (scope !== kbScopeRef.current) return;
      await api.request({
        url: 'aiKnowledgeBaseDoc:create',
        method: 'post',
        data: {
          values: {
            knowledgeBaseId: kbId,
            filename: values.filename,
            textContent: values.textContent,
            status: 'pending',
          },
        },
      });
      if (scope !== kbScopeRef.current) return;
      message.success('Text document added');
      setTextModalVisible(false);
      textForm.resetFields();
      fetchDocuments(kbId);
    } catch {
      if (scope === kbScopeRef.current) message.error('Failed to add text document');
    }
  };

  const handleDeleteDocument = async (docId: string) => {
    const kbId = selectedKBRef.current?.id;
    const scope = kbScopeRef.current;
    if (!kbId || !documents.some((doc) => doc.id === docId)) return;
    try {
      await api.request({
        url: 'aiKnowledgeBaseDoc:destroy',
        method: 'post',
        params: { filterByTk: docId },
      });
      if (scope !== kbScopeRef.current) return;
      message.success('Document deleted');
      fetchDocuments(kbId);
    } catch {
      if (scope === kbScopeRef.current) message.error('Delete failed');
    }
  };

  const handleBulkDelete = async () => {
    const kbId = selectedKBRef.current?.id;
    const scope = kbScopeRef.current;
    const documentIds =
      documentSelection.scope === scope
        ? documentSelection.ids.filter((id) => documents.some((doc) => doc.id === id))
        : [];
    if (!kbId || !documentIds.length) return;
    try {
      await api.request({
        url: 'aiKnowledgeBaseDoc:bulkDestroy',
        method: 'post',
        data: { values: { knowledgeBaseId: kbId, documentIds } },
      });
      if (scope !== kbScopeRef.current) return;
      message.success(`Deleted ${documentIds.length} document(s)`);
      setDocumentSelection({ scope, ids: [] });
      fetchDocuments(kbId);
    } catch {
      if (scope === kbScopeRef.current) message.error('Bulk delete failed');
    }
  };

  const handleBulkReprocess = async () => {
    const kbId = selectedKBRef.current?.id;
    const scope = kbScopeRef.current;
    const documentIds =
      documentSelection.scope === scope
        ? documentSelection.ids.filter((id) => documents.some((doc) => doc.id === id))
        : [];
    if (!kbId || !documentIds.length) return;
    try {
      const res = await api.request({
        url: 'aiKnowledgeBaseDoc:bulkReprocess',
        method: 'post',
        data: { values: { knowledgeBaseId: kbId, documentIds } },
      });
      if (scope !== kbScopeRef.current) return;
      const queuedCount = res?.data?.data?.queuedCount ?? 0;
      message.success(`Queued ${queuedCount} of ${documentIds.length} document(s) for reprocessing`);
      setDocumentSelection({ scope, ids: [] });
      fetchDocuments(kbId);
    } catch {
      if (scope === kbScopeRef.current) message.error('Bulk reprocess failed');
    }
  };

  const handleReprocess = async (docId: string) => {
    const kbId = selectedKBRef.current?.id;
    const scope = kbScopeRef.current;
    if (!kbId || !documents.some((doc) => doc.id === docId)) return;
    try {
      await api.request({
        url: 'aiKnowledgeBaseDoc:reprocess',
        method: 'post',
        params: { filterByTk: docId },
      });
      if (scope !== kbScopeRef.current) return;
      message.success('Reprocessing started');
      fetchDocuments(kbId);
    } catch {
      if (scope === kbScopeRef.current) message.error('Reprocess failed');
    }
  };

  const handleKnowledgeSearch = async () => {
    if (!selectedKB || !kbSearchQuery.trim()) {
      message.warning('Enter a search query first');
      return;
    }

    const scope = kbScopeRef.current;
    const requestId = ++searchRequestRef.current;
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
      if (scope === kbScopeRef.current && requestId === searchRequestRef.current) {
        setKbSearchResults(res?.data?.data?.data ?? []);
      }
    } catch {
      if (scope === kbScopeRef.current && requestId === searchRequestRef.current) message.error('Search failed');
    } finally {
      if (scope === kbScopeRef.current && requestId === searchRequestRef.current) setKbSearchLoading(false);
    }
  };

  const handleSearchFeedback = async (item: any, feedback: 'positive' | 'negative') => {
    if (!selectedKB) return;
    const scope = kbScopeRef.current;
    try {
      await api.request({
        url: 'aiKnowledgeBase:submitSearchFeedback',
        method: 'post',
        data: {
          values: {
            knowledgeBaseId: selectedKB.id,
            query: kbSearchQuery,
            documentId: item.id ?? item.metadata?.documentId,
            feedback,
            rerankScore: Number(item.rerankScore ?? item.score ?? 0),
          },
        },
      });
      if (scope === kbScopeRef.current) {
        message.success(feedback === 'positive' ? 'Thanks for the positive feedback!' : 'Feedback recorded');
      }
    } catch {
      if (scope === kbScopeRef.current) message.error('Failed to submit feedback');
    }
  };

  // Renders
  const renderSidebar = () => {
    const filtered = knowledgeBases.filter((kb) => {
      const matchesText = kb.name.toLowerCase().includes(searchText.toLowerCase());
      const matchesType = sidebarTypeFilter === 'all' || (kb.type || 'LOCAL') === sidebarTypeFilter;
      return matchesText && matchesType;
    });

    return (
      <div
        style={{
          width: 320,
          borderRight: '1px solid #f0f0f0',
          display: 'flex',
          flexDirection: 'column',
          background: '#ffffff',
          height: '100%',
          boxShadow: '2px 0 8px 0 rgba(29,35,41,.05)',
          zIndex: 1,
        }}
      >
        <div
          style={{
            padding: '20px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            borderBottom: '1px solid #f0f0f0',
            background: '#fafafa',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Title level={5} style={{ margin: 0 }}>
              Knowledge Bases
            </Title>
            <Button type="primary" shape="round" icon={<PlusOutlined />} onClick={handleCreate}>
              Create
            </Button>
          </div>
          <Input.Search
            placeholder="Search bases..."
            allowClear
            onChange={(e) => setSearchText(e.target.value)}
            style={{ borderRadius: 8 }}
          />
          <Select
            value={sidebarTypeFilter}
            onChange={setSidebarTypeFilter}
            options={[
              { label: 'All types', value: 'all' },
              ...Object.entries(kbTypeConfig).map(([value, config]) => ({ label: config.label, value })),
            ]}
            bordered={false}
            style={{ background: '#fff', borderRadius: 8, border: '1px solid #d9d9d9' }}
          />
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
          {loading && filtered.length === 0 ? (
            <div style={{ padding: 48, textAlign: 'center' }}>
              <Spin size="large" />
            </div>
          ) : filtered.length === 0 ? (
            <Empty description="No knowledge bases found" style={{ marginTop: 48 }} />
          ) : (
            filtered.map((kb) => {
              const isActive = selectedKB?.id === kb.id;
              const docCount = kb.documents?.length || 0;
              const failedCount = kb.documents?.filter((d: any) => d.status === 'failed').length || 0;
              const processingCount = kb.documents?.filter((d: any) => d.status === 'processing').length || 0;
              const typeConfig = kbTypeConfig[kb.type || 'LOCAL'] || kbTypeConfig.LOCAL;

              return (
                <div
                  key={kb.id}
                  onClick={() => selectKnowledgeBase(kb)}
                  style={{
                    padding: '16px',
                    marginBottom: '8px',
                    cursor: 'pointer',
                    background: isActive ? '#f0f7ff' : '#ffffff',
                    border: isActive ? '1px solid #91caff' : '1px solid #f0f0f0',
                    borderRadius: '12px',
                    transition: 'all 0.3s ease',
                    boxShadow: isActive ? '0 2px 8px rgba(24, 144, 255, 0.15)' : 'none',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: '8px',
                        background: isActive ? '#1890ff' : '#fafafa',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: isActive ? '#fff' : '#8c8c8c',
                        fontSize: 18,
                        transition: 'all 0.3s ease',
                      }}
                    >
                      {isActive ? <BookOutlined /> : accessIcons[kb.accessLevel || 'PUBLIC']}
                    </div>
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <Text
                        strong
                        style={{ fontSize: 15, display: 'block', color: isActive ? '#1890ff' : 'inherit' }}
                        ellipsis
                      >
                        {kb.name}
                      </Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {docCount} documents
                      </Text>
                    </div>
                  </div>
                  <div
                    style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                  >
                    <Space size={4} wrap>
                      <Tag color={typeConfig.color} style={{ borderRadius: 4, margin: 0 }}>
                        {typeConfig.label}
                      </Tag>
                      {processingCount > 0 && (
                        <Tag color="processing" style={{ borderRadius: 4, margin: 0 }}>
                          {processingCount} processing
                        </Tag>
                      )}
                      {failedCount > 0 && (
                        <Tag color="error" style={{ borderRadius: 4, margin: 0 }}>
                          {failedCount} err
                        </Tag>
                      )}
                    </Space>
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

    const documentColumns = [
      {
        title: 'Document',
        dataIndex: 'filename',
        key: 'filename',
        render: (_: string, doc: any) => (
          <Space>
            <FileTextOutlined style={{ color: '#8c8c8c' }} />
            <Tooltip title={doc.filename}>
              <Text style={{ maxWidth: 360 }} ellipsis>
                {doc.filename || 'Untitled'}
              </Text>
            </Tooltip>
          </Space>
        ),
      },
      {
        title: 'Status',
        dataIndex: 'status',
        key: 'status',
        width: 150,
        render: (status: string, doc: any) => {
          const cfg = statusConfig[status] || { color: 'default', label: status };
          return (
            <Space direction="vertical" size={2}>
              <Tag color={cfg.color} style={{ margin: 0 }}>
                {cfg.label}
              </Tag>
              {doc.error && status === 'failed' && (
                <Tooltip title={doc.error}>
                  <Text type="danger" style={{ fontSize: 12, maxWidth: 220 }} ellipsis>
                    {doc.error}
                  </Text>
                </Tooltip>
              )}
            </Space>
          );
        },
      },
      {
        title: 'Chunks',
        dataIndex: 'chunkCount',
        key: 'chunkCount',
        width: 100,
        render: (value: number) => value || 0,
      },
      {
        title: 'Updated',
        dataIndex: 'updatedAt',
        key: 'updatedAt',
        width: 190,
        render: formatDate,
      },
      {
        title: 'Actions',
        key: 'actions',
        width: 120,
        render: (_: any, doc: any) => {
          const isProcessing = doc.status === 'processing';
          const fileDeleted = selectedKB?.deleteSourceFile && !doc.fileId && !doc.textContent;
          const reprocessTip = isProcessing ? 'Processing...' : fileDeleted ? 'Source file deleted' : 'Reprocess';

          return (
            <Space size={4}>
              <Tooltip title={reprocessTip}>
                <Button
                  type="text"
                  icon={<ReloadOutlined />}
                  onClick={() => handleReprocess(doc.id)}
                  disabled={isProcessing || fileDeleted}
                />
              </Tooltip>
              <Popconfirm title="Delete document?" onConfirm={() => handleDeleteDocument(doc.id)}>
                <Tooltip title="Delete">
                  <Button type="text" danger icon={<DeleteOutlined />} />
                </Tooltip>
              </Popconfirm>
            </Space>
          );
        },
      },
    ];

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          minWidth: 0,
          height: '100%',
          minHeight: 0,
          gap: 16,
        }}
      >
        <Row gutter={[16, 16]} style={{ flex: '0 0 auto' }}>
          <Col xs={24} md={14}>
            <Card
              hoverable
              bodyStyle={{ padding: 0 }}
              style={{ height: 88, borderRadius: 12, overflow: 'hidden', border: '1px solid #e8e8e8' }}
            >
              <Dragger
                name="file"
                multiple
                showUploadList={false}
                accept=".txt,.md,.pdf,.doc,.docx,.ppt,.pptx,.csv,.json"
                customRequest={handleFileUpload}
                style={{ height: '100%', padding: '0 20px', background: '#fafafa', border: 'none' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, minHeight: 86, textAlign: 'left' }}>
                  <InboxOutlined style={{ color: '#1890ff', fontSize: 32 }} />
                  <div>
                    <Text strong>Click or drag file to this area to upload</Text>
                  </div>
                </div>
              </Dragger>
            </Card>
          </Col>

          <Col xs={24} md={10}>
            <Card
              hoverable
              bodyStyle={{ height: '100%', padding: 0 }}
              style={{
                height: 88,
                borderRadius: 12,
                border: '1px solid #e8e8e8',
                background: '#fafafa',
              }}
            >
              <Button
                type="text"
                block
                onClick={() => setTextModalVisible(true)}
                style={{ height: '100%', padding: '0 20px', textAlign: 'left', whiteSpace: 'normal' }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <FileTextOutlined style={{ fontSize: 32, color: '#52c41a' }} />
                  <span>
                    <Text strong>Paste Plain Text</Text>
                  </span>
                </span>
              </Button>
            </Card>
          </Col>
        </Row>

        <Card
          title="Document List"
          style={{
            borderRadius: 12,
            border: '1px solid #e8e8e8',
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
          headStyle={{ minHeight: 48, borderBottom: '1px solid #f0f0f0', padding: '0 16px' }}
          bodyStyle={{
            padding: '12px 16px',
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
          extra={
            <Space>
              <Select
                size="middle"
                value={docStatusFilter}
                onChange={setDocStatusFilter}
                options={statusFilters}
                style={{ width: 140 }}
              />
              <Button icon={<ReloadOutlined />} onClick={() => selectedKB && fetchDocuments(selectedKB.id)}>
                Refresh
              </Button>
            </Space>
          }
        >
          <div style={{ marginBottom: 8, flex: '0 0 auto' }}>
            <Space wrap size={[0, 8]}>
              <Tag icon={<FileTextOutlined />} color="blue" style={{ borderRadius: 4 }}>
                {documentStats.total} total
              </Tag>
              <Tag icon={<CheckCircleOutlined />} color="success" style={{ borderRadius: 4 }}>
                {documentStats.success} ready
              </Tag>
              <Tag icon={<SyncOutlined />} color="processing" style={{ borderRadius: 4 }}>
                {documentStats.processing} processing
              </Tag>
              <Tag icon={<ClockCircleOutlined />} color="warning" style={{ borderRadius: 4 }}>
                {documentStats.pending || 0} pending
              </Tag>
              <Tag icon={<CloseCircleOutlined />} color="error" style={{ borderRadius: 4 }}>
                {documentStats.failed} failed
              </Tag>
            </Space>
            {selectedDocIds.length > 0 && (
              <Space style={{ marginLeft: 'auto' }}>
                <Text type="secondary">{selectedDocIds.length} selected</Text>
                <Popconfirm title={`Reprocess ${selectedDocIds.length} document(s)?`} onConfirm={handleBulkReprocess}>
                  <Button size="small" icon={<SyncOutlined />}>
                    Reprocess
                  </Button>
                </Popconfirm>
                <Popconfirm
                  title={`Delete ${selectedDocIds.length} document(s)? This cannot be undone.`}
                  onConfirm={handleBulkDelete}
                >
                  <Button size="small" danger icon={<DeleteOutlined />}>
                    Delete
                  </Button>
                </Popconfirm>
              </Space>
            )}
          </div>
          <div ref={documentTableViewportRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            <Table
              key={selectedKB?.id}
              rowKey="id"
              rowSelection={{
                selectedRowKeys: selectedDocIds,
                onChange: (keys: React.Key[]) => setDocumentSelection({ scope: kbScopeRef.current, ids: keys }),
              }}
              size="small"
              loading={docsLoading}
              columns={documentColumns}
              dataSource={filteredDocuments}
              locale={{ emptyText: <Empty description="No documents match this view" /> }}
              pagination={{ pageSize: 10, showSizeChanger: true, size: 'small' }}
              scroll={{ x: 760, y: documentTableScrollY }}
            />
          </div>
        </Card>
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
        <InputNumber
          min={1}
          max={20}
          value={kbSearchTopK}
          aria-label="Maximum search results"
          addonBefore="Results"
          style={{ flex: '0 0 auto', width: 152 }}
          onChange={(value) => setKbSearchTopK(value || 5)}
        />
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
                    <Button
                      type="text"
                      size="small"
                      icon={<LikeOutlined />}
                      onClick={() => handleSearchFeedback(item, 'positive')}
                      aria-label="Helpful result"
                    />
                    <Button
                      type="text"
                      size="small"
                      icon={<DislikeOutlined />}
                      onClick={() => handleSearchFeedback(item, 'negative')}
                      aria-label="Not helpful"
                    />
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
    currentType: string,
    currentAccessLevel: string,
    setCA: (v: string) => void,
    setCT: (v: string) => void,
    isSettings = false,
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
          <Col span={24}>
            <Form.Item name="allowedRoles" label="Allowed roles" rules={[{ required: true }]}>
              <Select mode="multiple" options={roleOptions} />
            </Form.Item>
          </Col>
        </Row>
      )}

      <Row gutter={16}>
        <Col span={12}>
          <Form.Item
            name="agentAccess"
            label="Agent access"
            initialValue="inherit"
            tooltip="Controls how AI Employees may reach this KB. Inherit: rides on the triggering user's access. Explicit: only named agents (or agents holding an allowed role). None: no agent access."
          >
            <Select options={agentAccessOptions} />
          </Form.Item>
        </Col>
        {currentType !== 'EXTERNAL_RAG' && (
          <Col span={12}>
            <Form.Item
              name="vectorStoreId"
              label="Vector Store"
              rules={[{ required: currentType !== 'READONLY' && currentType !== 'EXTERNAL' }]}
            >
              <Select options={vectorStores.map((vs: any) => ({ label: vs.name, value: vs.id }))} />
            </Form.Item>
          </Col>
        )}
      </Row>

      <Form.Item noStyle shouldUpdate={(prev, cur) => prev.agentAccess !== cur.agentAccess}>
        {({ getFieldValue }) =>
          getFieldValue('agentAccess') === 'explicit' ? (
            <Form.Item
              name="allowedAgents"
              label="Allowed agents"
              tooltip="AI Employees explicitly granted access. Agents holding a role in 'Allowed roles' also pass."
            >
              <Select mode="multiple" options={agentOptions} placeholder="Select AI Employees" />
            </Form.Item>
          ) : null
        }
      </Form.Item>

      {currentType === 'EXTERNAL_RAG' && (
        <div style={{ background: '#f5f5f5', padding: 16, borderRadius: 8, marginBottom: 24 }}>
          <Text strong style={{ display: 'block', marginBottom: 16 }}>
            External RAG Configuration
          </Text>
          <Form.Item name="ragProvider" label="RAG Provider" initialValue="openai-compatible">
            <Select
              options={[
                { label: 'HTTP search API (backend embeds query)', value: 'external-http' },
                { label: 'HTTP search API + custom embedding model', value: 'openai-compatible' },
                { label: 'Legacy E5 HTTP (alias)', value: 'e5-http' },
              ]}
            />
          </Form.Item>
          <Form.Item name="ragApiUrl" label="API URL" rules={[{ required: true, type: 'url' }]}>
            <Input placeholder="https://rag.example.com/search" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="ragApiKey"
                label="API Key"
                extra={
                  isSettings && selectedKB?.options?.hasRagApiKey
                    ? t('A credential is configured. Leave blank to keep it.')
                    : undefined
                }
              >
                <Input.Password placeholder="Bearer token (optional)" />
              </Form.Item>
              {isSettings && selectedKB?.options?.hasRagApiKey && (
                <Form.Item name="clearRagApiKey" valuePropName="checked">
                  <Checkbox>{t('Clear saved credential')}</Checkbox>
                </Form.Item>
              )}
            </Col>
            <Col span={12}>
              <Form.Item name="ragNamespace" label="Namespace">
                <Input placeholder="Optional namespace" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item shouldUpdate={(prev, cur) => prev.ragProvider !== cur.ragProvider} noStyle>
            {({ getFieldValue }) =>
              ['openai-compatible', 'e5-http'].includes(getFieldValue('ragProvider')) ? (
                <>
                  <Row gutter={16}>
                    <Col span={12}>
                      <Form.Item
                        name="ragEmbeddingLlmService"
                        label="Embedding LLM Service"
                        rules={[{ required: true }]}
                      >
                        <Select
                          placeholder="Select embedding service"
                          options={llmServices.map((svc: any) => ({ label: svc.title || svc.name, value: svc.name }))}
                        />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="ragEmbeddingModel" label="Embedding Model" rules={[{ required: true }]}>
                        <Input placeholder="text-embedding-3-small or intfloat/multilingual-e5-base" />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Row gutter={16}>
                    <Col span={12}>
                      <Form.Item name="ragQueryPrefix" label="Query Prefix" initialValue="query: ">
                        <Input placeholder="query: " />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="ragPassagePrefix" label="Passage Prefix" initialValue="passage: ">
                        <Input placeholder="passage: " />
                      </Form.Item>
                    </Col>
                  </Row>
                </>
              ) : null
            }
          </Form.Item>
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
    <>
      <style>{`
        .kb-detail-tabs .ant-tabs-content-holder,
        .kb-detail-tabs .ant-tabs-content,
        .kb-detail-tabs .ant-tabs-tabpane-active {
          display: flex;
          flex: 1;
          flex-direction: column;
          min-height: 0;
        }
      `}</style>
      <div
        ref={knowledgeBasesPageRef}
        style={{
          display: 'flex',
          height: knowledgeBasesPageHeight ?? 'calc(100dvh - 56px)',
          minHeight: 0,
          overflow: 'hidden',
          background: '#f5f5f5',
        }}
      >
        {renderSidebar()}

        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            padding: '24px',
          }}
        >
          {selectedKB ? (
            <div
              style={{
                background: '#fff',
                borderRadius: 12,
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                minHeight: 0,
                boxShadow: '0 4px 16px rgba(0,0,0,0.04)',
                border: '1px solid #f0f0f0',
              }}
            >
              <div style={{ padding: '24px 32px 16px', borderBottom: '1px solid #f0f0f0' }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    marginBottom: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div
                      style={{
                        width: 56,
                        height: 56,
                        borderRadius: '12px',
                        background: '#e6f4ff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#1890ff',
                        fontSize: 28,
                      }}
                    >
                      <BookOutlined />
                    </div>
                    <div>
                      <Title
                        level={3}
                        style={{ margin: 0, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12 }}
                      >
                        {selectedKB.name}
                        <Space size={4}>
                          <Tag
                            color={selectedTypeConfig.color}
                            style={{ borderRadius: 4, fontWeight: 'normal', fontSize: 12 }}
                          >
                            {selectedTypeConfig.label}
                          </Tag>
                          <Tag
                            color={accessColors[selectedKB.accessLevel || 'PUBLIC']}
                            style={{ borderRadius: 4, fontWeight: 'normal', fontSize: 12 }}
                          >
                            {selectedKB.accessLevel || 'PUBLIC'}
                          </Tag>
                          <Tag
                            color={selectedKB.enabled === false ? 'default' : 'success'}
                            style={{ borderRadius: 4, fontWeight: 'normal', fontSize: 12 }}
                          >
                            {selectedKB.enabled === false ? 'Disabled' : 'Active'}
                          </Tag>
                        </Space>
                      </Title>
                      <Text type="secondary" style={{ fontSize: 14 }}>
                        {selectedKB.description ||
                          'Manage documents, search content, and configure settings for this knowledge base.'}
                      </Text>
                    </div>
                  </div>
                  <Popconfirm
                    title="Are you sure to delete this knowledge base? This action cannot be undone."
                    onConfirm={() => handleDeleteKB(selectedKB.id)}
                  >
                    <Button danger shape="round" icon={<DeleteOutlined />}>
                      Delete
                    </Button>
                  </Popconfirm>
                </div>
              </div>

              <Tabs
                defaultActiveKey="documents"
                style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '0 32px' }}
                className="kb-detail-tabs"
                items={[
                  {
                    key: 'documents',
                    label: (
                      <span style={{ fontSize: 15, padding: '8px 16px' }}>
                        <FileTextOutlined /> Documents
                      </span>
                    ),
                    children: (
                      <div
                        style={{ padding: '16px 0', overflow: 'hidden', height: '100%', minHeight: 0, display: 'flex' }}
                      >
                        {renderDocumentsTab()}
                      </div>
                    ),
                  },
                  {
                    key: 'search',
                    label: (
                      <span style={{ fontSize: 15, padding: '8px 16px' }}>
                        <SearchOutlined /> Search
                      </span>
                    ),
                    children: (
                      <div style={{ padding: '16px 0', overflowY: 'auto', height: '100%' }}>{renderSearchTab()}</div>
                    ),
                  },
                  {
                    key: 'settings',
                    label: (
                      <span style={{ fontSize: 15, padding: '8px 16px' }}>
                        <SettingOutlined /> Settings
                      </span>
                    ),
                    children: (
                      <div style={{ padding: '16px 0', overflowY: 'auto', height: '100%', maxWidth: 800 }}>
                        <Form
                          form={settingsForm}
                          layout="vertical"
                          onFinish={(values) => handleUpdateSettings(selectedKB.id, currentScope, values)}
                        >
                          {formFields(sType, sAccessLevel, setSAccessLevel, setSType, true)}
                          <Form.Item style={{ marginTop: 24 }}>
                            <Button type="primary" htmlType="submit" size="large" shape="round">
                              Save Changes
                            </Button>
                          </Form.Item>
                        </Form>
                      </div>
                    ),
                  },
                ]}
              />
            </div>
          ) : (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#fff',
                borderRadius: 12,
                boxShadow: '0 4px 16px rgba(0,0,0,0.04)',
                border: '1px solid #f0f0f0',
              }}
            >
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <span style={{ color: '#8c8c8c', fontSize: 16 }}>
                    Select a knowledge base from the sidebar or create a new one
                  </span>
                }
              >
                <Button
                  type="primary"
                  size="large"
                  shape="round"
                  icon={<PlusOutlined />}
                  onClick={handleCreate}
                  style={{ marginTop: 16 }}
                >
                  Create Knowledge Base
                </Button>
              </Empty>
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
            {formFields(cType, cAccessLevel, setCAccessLevel, setCType)}
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
    </>
  );
};

export default KnowledgeBases;
