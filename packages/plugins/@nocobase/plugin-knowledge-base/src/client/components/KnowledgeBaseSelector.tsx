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
  uploadRoles?: string[];
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
  PRIVATE: <LockOutlined style={{ color: '#722ed1' }} />,
};

const accessColors: Record<string, string> = {
  PUBLIC: 'green',
  SHARED: 'orange',
  BASIC: 'blue',
  PRIVATE: 'purple',
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
      return kb.uploadRoles?.some((r) => currentUserRoles.includes(r)) || false;
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
    <div style={{ display: 'flex', height: '65vh', minHeight: 480 }}>
      {/* ====== LEFT SIDEBAR ====== */}
      <div
        style={{
          width: 260,
          borderRight: '1px solid #f0f0f0',
          overflowY: 'auto',
          background: '#fafafa',
        }}
      >
        <div style={{ padding: '14px 16px 8px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Text strong style={{ fontSize: 14 }}>
            Knowledge Bases
          </Text>
          <Input.Search
            placeholder="Search..."
            size="small"
            allowClear
            onChange={(e) => setSearchText(e.target.value)}
          />
        </div>
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
                  padding: '10px 16px',
                  cursor: 'pointer',
                  background: isActive ? '#e6f4ff' : 'transparent',
                  borderLeft: isActive ? '3px solid #1890ff' : '3px solid transparent',
                  transition: 'all 0.2s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {accessIcons[kb.accessLevel || 'PUBLIC']}
                  <Text strong={isActive} style={{ flex: 1, fontSize: 13 }} ellipsis>
                    {kb.name}
                  </Text>
                  {isChatSelected && <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 14 }} />}
                </div>
                <div style={{ marginTop: 4, display: 'flex', gap: 4 }}>
                  <Tag
                    color={accessColors[kb.accessLevel || 'PUBLIC']}
                    style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}
                  >
                    {kb.accessLevel || 'PUBLIC'}
                  </Tag>
                </div>
              </div>
            );
          })}
      </div>

      {/* ====== RIGHT CONTENT ====== */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {selectedKB ? (
          <>
            {/* Header */}
            <div
              style={{
                padding: '12px 20px',
                borderBottom: '1px solid #f0f0f0',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexShrink: 0,
              }}
            >
              <div>
                <Title level={5} style={{ margin: 0 }}>
                  {selectedKB.name}
                </Title>
                {selectedKB.description && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {selectedKB.description}
                  </Text>
                )}
              </div>
              <Space>
                <Button
                  type={chatSelectedIds.has(selectedKB.id) ? 'primary' : 'default'}
                  icon={chatSelectedIds.has(selectedKB.id) ? <CheckCircleOutlined /> : <BookOutlined />}
                  onClick={() => handleChatToggle(selectedKB)}
                >
                  {chatSelectedIds.has(selectedKB.id) ? 'Selected' : 'Select for Chat'}
                </Button>
              </Space>
            </div>

            {/* Document Table */}
            <div style={{ flex: 1, overflow: 'auto', padding: '12px 20px' }}>
              {showUploadArea && (
                <div style={{ marginBottom: 16 }}>
                  <Dragger
                    name="file"
                    multiple
                    showUploadList={false}
                    accept=".txt,.md,.pdf,.doc,.docx,.ppt,.pptx,.csv,.json"
                    customRequest={({ file, onSuccess, onError }) => handleFileUpload(file, onSuccess, onError)}
                    onChange={handleUploadChange}
                    style={{ padding: '16px 0', background: '#fafafa' }}
                  >
                    <p className="ant-upload-drag-icon" style={{ marginBottom: 8 }}>
                      <InboxOutlined />
                    </p>
                    <p className="ant-upload-text" style={{ fontSize: 13, margin: 0, marginBottom: 8 }}>
                      Drag files here or
                    </p>
                    <Space>
                      <Button type="primary" size="small" icon={<UploadOutlined />}>
                        Upload File
                      </Button>
                      <Button
                        size="small"
                        icon={<PlusOutlined />}
                        onClick={(e) => {
                          e.stopPropagation();
                          setTextModalVisible(true);
                        }}
                      >
                        Paste Text
                      </Button>
                    </Space>
                  </Dragger>
                </div>
              )}

              <Table
                dataSource={documents}
                columns={docColumns}
                rowKey="id"
                size="small"
                loading={docsLoading}
                pagination={{ pageSize: 8, size: 'small', showSizeChanger: false }}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No documents yet" /> }}
              />
            </div>
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty description="Select a knowledge base" />
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
