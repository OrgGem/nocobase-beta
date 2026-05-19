/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  Spin,
  Typography,
  Empty,
  Space,
  Button,
  Tag,
  Table,
  Upload,
  Input,
  Modal,
  Form,
  message,
  Popconfirm,
  Tooltip,
  Badge,
} from 'antd';
import {
  BookOutlined,
  CloseOutlined,
  UploadOutlined,
  DeleteOutlined,
  ReloadOutlined,
  CheckCircleOutlined,
  PlusOutlined,
  FileTextOutlined,
  InboxOutlined,
  GlobalOutlined,
  TeamOutlined,
  LockOutlined,
} from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';

const { Text, Title } = Typography;
const { Dragger } = Upload;

export type KnowledgeBaseSelectorProps = {
  contextItems?: { type: string; uid: string; title?: string }[];
  onAdd: (item: { uid: string; title?: string; content?: unknown }) => void;
  onRemove: (uid: string) => void;
  onClose?: () => void;
};

type KnowledgeBaseItem = {
  id: string;
  name: string;
  description?: string;
  type?: string;
  accessLevel?: string;
  enabled: boolean;
  fileStorage?: string;
  allowedRoles?: string[];
  deleteSourceFile?: boolean;
};

type DocumentItem = {
  id: string;
  filename: string;
  status: string;
  chunkCount?: number;
  error?: string;
  createdAt?: string;
  textContent?: string;
  fileId?: string;
};

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

export const KnowledgeBaseSelector: React.FC<KnowledgeBaseSelectorProps> = ({
  contextItems = [],
  onAdd,
  onRemove,
  onClose,
}) => {
  const apiClient = useAPIClient();
  const [loading, setLoading] = useState(true);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseItem[]>([]);
  const [selectedKB, setSelectedKB] = useState<KnowledgeBaseItem | null>(null);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [textModalVisible, setTextModalVisible] = useState(false);
  const [textForm] = Form.useForm();
  const [currentUserRoles, setCurrentUserRoles] = useState<string[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);

  const chatSelectedIds = new Set(
    contextItems.filter((item) => item.type === 'knowledge-base').map((item) => item.uid),
  );

  // Fetch current user info
  useEffect(() => {
    const fetchUserInfo = async () => {
      try {
        const res = await apiClient.request({ url: 'auth:check' });
        const userData = res?.data?.data;
        const roles = userData?.roles?.map((r: any) => r.name || r) || [];
        setCurrentUserRoles(roles);
        setIsAdmin(roles.includes('root') || roles.includes('admin'));
      } catch {
        // ignore
      }
    };
    fetchUserInfo();
  }, [apiClient]);

  // Fetch KBs
  useEffect(() => {
    const fetchKnowledgeBases = async () => {
      try {
        setLoading(true);
        const response = await apiClient.resource('aiKnowledgeBase').list({
          params: {
            filter: { enabled: true },
            sort: ['-createdAt'],
          },
        });
        const kbs = response?.data?.data || [];
        setKnowledgeBases(kbs);
        if (kbs.length > 0 && !selectedKB) {
          setSelectedKB(kbs[0]);
        }
      } catch (err) {
        console.error('Failed to fetch knowledge bases:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchKnowledgeBases();
  }, [apiClient]);

  // Fetch documents when KB selection changes
  const fetchDocuments = useCallback(
    async (kbId: string) => {
      setDocsLoading(true);
      try {
        const res = await apiClient.request({
          url: 'aiKnowledgeBaseDoc:list',
          params: { filter: { knowledgeBaseId: kbId } },
        });
        setDocuments(res?.data?.data ?? []);
      } catch {
        message.error('Failed to load documents');
      } finally {
        setDocsLoading(false);
      }
    },
    [apiClient],
  );

  useEffect(() => {
    if (selectedKB) {
      fetchDocuments(selectedKB.id);
    }
  }, [selectedKB?.id, fetchDocuments]);

  // Check if user can upload to this KB
  const canUpload = (kb: KnowledgeBaseItem): boolean => {
    if (isAdmin) return true;
    if (kb.accessLevel === 'BASIC') return true; // Owner can always upload to their own KB
    if (kb.accessLevel === 'PUBLIC') return false; // Only admin can upload to PUBLIC
    if (kb.accessLevel === 'SHARED') {
      return kb.allowedRoles?.some((r) => currentUserRoles.includes(r)) || false;
    }
    return false;
  };

  const handleChatToggle = (kb: KnowledgeBaseItem) => {
    if (chatSelectedIds.has(kb.id)) {
      onRemove(kb.id);
    } else {
      onAdd({
        uid: kb.id,
        title: kb.name,
        content: { knowledgeBaseId: kb.id, name: kb.name },
      });
    }
  };

  // Upload file handler
  const handleFileUpload = (file: any, onSuccess: any, onError: any) => {
    if (!selectedKB) return;
    const formData = new FormData();
    formData.append('file', file);
    const storageParam = selectedKB.fileStorage ? `?storageRule=${encodeURIComponent(selectedKB.fileStorage)}` : '';
    apiClient.axios
      .post(`aiFiles:create${storageParam}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((res: any) => onSuccess?.(res.data, file))
      .catch((err: any) => onError?.(err));
  };

  const handleUploadChange = (info: any) => {
    if (info.file.status === 'done') {
      const attachment = info.file.response?.data;
      if (attachment && selectedKB) {
        apiClient
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
          .catch(() => message.error('Failed to create document record'));
      }
    } else if (info.file.status === 'error') {
      message.error(`Upload failed: ${info.file.name}`);
    }
  };

  const handleAddTextDocument = async () => {
    try {
      const values = await textForm.validateFields();
      if (!selectedKB) return;
      await apiClient.request({
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
      await apiClient.request({
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
      await apiClient.request({
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

  const docColumns = [
    {
      title: 'Document',
      dataIndex: 'filename',
      key: 'filename',
      ellipsis: true,
      render: (val: string) => (
        <Space>
          <FileTextOutlined style={{ color: '#8c8c8c' }} />
          <Text>{val}</Text>
        </Space>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (val: string) => {
        const cfg = statusConfig[val] || { color: 'default', label: val };
        return <Tag color={cfg.color}>{cfg.label}</Tag>;
      },
    },
    {
      title: 'Chunks',
      dataIndex: 'chunkCount',
      key: 'chunkCount',
      width: 70,
      render: (val: number) => val || '-',
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 140,
      render: (_: any, record: DocumentItem) => {
        if (!selectedKB || !canUpload(selectedKB)) return null;
        const isProcessing = record.status === 'processing';
        const fileDeleted = selectedKB.deleteSourceFile && !record.fileId && !record.textContent;
        const reprocessDisabled = isProcessing || fileDeleted;
        const reprocessTip = isProcessing
          ? 'Embedding in progress...'
          : fileDeleted
            ? 'Source file has been deleted'
            : 'Reprocess';
        return (
          <Space size="small">
            <Tooltip title={reprocessTip}>
              <Button
                size="small"
                type="text"
                icon={<ReloadOutlined />}
                onClick={() => handleReprocess(record.id)}
                disabled={reprocessDisabled}
              />
            </Tooltip>
            <Popconfirm
              title="Delete this document?"
              onConfirm={() => handleDeleteDocument(record.id)}
              okText="Yes"
              cancelText="No"
            >
              <Tooltip title="Delete">
                <Button size="small" type="text" danger icon={<DeleteOutlined />} />
              </Tooltip>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  if (loading) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!knowledgeBases.length) {
    return (
      <div style={{ padding: 48 }}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No knowledge bases available" />
      </div>
    );
  }

  const showUploadArea = selectedKB && canUpload(selectedKB);

  return (
    <div style={{ display: 'flex', height: '65vh', minHeight: 480, background: '#f5f5f5', borderRadius: 12, overflow: 'hidden' }}>
      {/* ====== LEFT SIDEBAR ====== */}
      <div
        style={{
          width: 280,
          borderRight: '1px solid #f0f0f0',
          display: 'flex',
          flexDirection: 'column',
          background: '#ffffff',
          boxShadow: '2px 0 8px 0 rgba(0,0,0,.02)',
          zIndex: 1,
        }}
      >
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12, background: '#fafafa', borderBottom: '1px solid #f0f0f0' }}>
          <Text strong style={{ fontSize: 15 }}>
            Knowledge Bases
          </Text>
          <Input.Search
            placeholder="Search bases..."
            size="middle"
            allowClear
            onChange={(e) => setSearchText(e.target.value)}
            style={{ borderRadius: 8 }}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
          {knowledgeBases
            .filter((kb) => kb.name.toLowerCase().includes(searchText.toLowerCase()))
            .map((kb) => {
              const isActive = selectedKB?.id === kb.id;
              const isChatSelected = chatSelectedIds.has(kb.id);
              return (
                <div
                  key={kb.id}
                  onClick={() => setSelectedKB(kb)}
                  style={{
                    padding: '12px',
                    marginBottom: '8px',
                    cursor: 'pointer',
                    background: isActive ? '#f0f7ff' : '#ffffff',
                    border: isActive ? '1px solid #91caff' : '1px solid #f0f0f0',
                    borderRadius: '10px',
                    transition: 'all 0.3s ease',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    boxShadow: isActive ? '0 2px 8px rgba(24, 144, 255, 0.1)' : 'none',
                  }}
                >
                  <div style={{ 
                    width: 32, 
                    height: 32, 
                    borderRadius: '8px', 
                    background: isActive ? '#1890ff' : '#fafafa', 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center',
                    color: isActive ? '#fff' : '#8c8c8c',
                    fontSize: 16
                  }}>
                    {isActive ? <BookOutlined /> : accessIcons[kb.accessLevel || 'PUBLIC']}
                  </div>
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Text strong style={{ fontSize: 14, color: isActive ? '#1890ff' : 'inherit' }} ellipsis>
                        {kb.name}
                      </Text>
                      {isChatSelected && <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 14 }} />}
                    </div>
                    <Tag
                      color={accessColors[kb.accessLevel || 'PUBLIC']}
                      style={{ fontSize: 10, lineHeight: '16px', padding: '0 6px', margin: '4px 0 0 0', borderRadius: 4 }}
                    >
                      {kb.accessLevel || 'PUBLIC'}
                    </Tag>
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      {/* ====== RIGHT CONTENT ====== */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '16px' }}>
        {selectedKB ? (
          <div style={{ background: '#fff', borderRadius: 12, display: 'flex', flexDirection: 'column', height: '100%', boxShadow: '0 2px 12px rgba(0,0,0,0.03)', border: '1px solid #f0f0f0' }}>
            {/* Header */}
            <div
              style={{
                padding: '20px 24px',
                borderBottom: '1px solid #f0f0f0',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexShrink: 0,
              }}
            >
              <div>
                <Title level={4} style={{ margin: 0, marginBottom: 4 }}>
                  {selectedKB.name}
                </Title>
                {selectedKB.description && (
                  <Text type="secondary" style={{ fontSize: 13 }}>
                    {selectedKB.description}
                  </Text>
                )}
              </div>
              <Space>
                <Button
                  type={chatSelectedIds.has(selectedKB.id) ? 'primary' : 'default'}
                  icon={chatSelectedIds.has(selectedKB.id) ? <CheckCircleOutlined /> : <BookOutlined />}
                  onClick={() => handleChatToggle(selectedKB)}
                  shape="round"
                  size="large"
                >
                  {chatSelectedIds.has(selectedKB.id) ? 'Selected for Chat' : 'Select for Chat'}
                </Button>
              </Space>
            </div>

            {/* Document Table */}
            <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column' }}>
              {showUploadArea && (
                <div style={{ marginBottom: 20 }}>
                  <Dragger
                    name="file"
                    multiple
                    showUploadList={false}
                    accept=".txt,.md,.pdf,.doc,.docx,.ppt,.pptx,.csv,.json"
                    customRequest={({ file, onSuccess, onError }) => handleFileUpload(file, onSuccess, onError)}
                    onChange={handleUploadChange}
                    style={{ padding: '16px 0', background: '#fafafa', border: '1px dashed #d9d9d9', borderRadius: 8 }}
                  >
                    <Space direction="vertical" size={12}>
                      <InboxOutlined style={{ fontSize: 32, color: '#1890ff' }} />
                      <Text strong style={{ fontSize: 14 }}>
                        Click or drag file to this area to upload
                      </Text>
                      <Space>
                        <Button type="primary" shape="round" icon={<UploadOutlined />}>
                          Upload File
                        </Button>
                        <Button
                          shape="round"
                          icon={<PlusOutlined />}
                          onClick={(e) => {
                            e.stopPropagation();
                            setTextModalVisible(true);
                          }}
                        >
                          Paste Text
                        </Button>
                      </Space>
                    </Space>
                  </Dragger>
                </div>
              )}

              <Table
                dataSource={documents}
                columns={docColumns}
                rowKey="id"
                size="middle"
                loading={docsLoading}
                pagination={{ pageSize: 8, size: 'small', showSizeChanger: false }}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No documents yet" /> }}
                style={{ flex: 1 }}
              />
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff', borderRadius: 12, border: '1px solid #f0f0f0' }}>
            <Empty description="Select a knowledge base from the list" />
          </div>
        )}
      </div>

      {/* Text Document Modal */}
      <Modal
        title="Add Text Document"
        open={textModalVisible}
        onOk={handleAddTextDocument}
        onCancel={() => setTextModalVisible(false)}
        destroyOnClose
        width={500}
      >
        <Form form={textForm} layout="vertical">
          <Form.Item name="filename" label="Document Name" rules={[{ required: true }]}>
            <Input placeholder="e.g. Company FAQ" />
          </Form.Item>
          <Form.Item name="textContent" label="Content" rules={[{ required: true }]}>
            <Input.TextArea autoSize={{ minRows: 6, maxRows: 16 }} placeholder="Paste your text content here..." />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};
