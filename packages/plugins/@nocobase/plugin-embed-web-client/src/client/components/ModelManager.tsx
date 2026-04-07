/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useAPIClient } from '@nocobase/client';
import { useTranslation } from 'react-i18next';
import {
  Card,
  Button,
  Space,
  Typography,
  Tag,
  Badge,
  List,
  Modal,
  Form,
  Input,
  Select,
  Upload,
  Progress,
  Divider,
  Popconfirm,
  message,
  Spin,
  Row,
  Col,
  Tooltip,
  Alert,
} from 'antd';
import {
  CloudUploadOutlined,
  DeleteOutlined,
  PlusOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  ThunderboltOutlined,
  FolderOpenOutlined,
} from '@ant-design/icons';

const { Text, Title } = Typography;

interface ModelInfo {
  modelId: string;
  source: 'bundled' | 'uploaded';
  dimensions: number | null;
  availableDtypes: string[];
  fileSizeBytes: number;
  baseFilesReady: boolean;
}

interface FileStatus {
  file: string;
  present: boolean;
  source: 'bundled' | 'uploaded';
}

const DTYPE_LABELS: Record<string, string> = {
  q4: 'q4 (smallest)',
  q8: 'q8 (recommended)',
  fp16: 'fp16',
  fp32: 'fp32 (full)',
};

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── Upload modal ──────────────────────────────────────────────────────────────

interface UploadModelModalProps {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}

const UploadModelModal: React.FC<UploadModelModalProps> = ({ open, onClose, onDone }) => {
  const api = useAPIClient();
  const { t } = useTranslation('plugin-embed-web-client');
  const [form] = Form.useForm();
  const [fileStatuses, setFileStatuses] = useState<FileStatus[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [uploadingFile, setUploadingFile] = useState<string | null>(null);

  const DTYPE_ONNX: Record<string, string> = {
    q4: 'onnx/model_q4.onnx',
    q8: 'onnx/model_quantized.onnx',
    fp16: 'onnx/model_fp16.onnx',
    fp32: 'onnx/model.onnx',
  };

  const fetchFileStatus = useCallback(async () => {
    const vals = form.getFieldsValue();
    if (!vals.modelId || !vals.dtype) return;
    setLoadingFiles(true);
    try {
      const res = await api.request({
        url: 'embedWebClient:getModelFiles',
        params: { modelId: vals.modelId, dtype: vals.dtype },
      });
      setFileStatuses(res?.data?.data?.files ?? []);
    } catch {
      /* ignore */
    } finally {
      setLoadingFiles(false);
    }
  }, [api, form]);

  const handleUploadFile = useCallback(
    async (filePath: string, file: File) => {
      const vals = form.getFieldsValue();
      setUploadingFile(filePath);
      const formData = new FormData();
      formData.append('file', file);
      formData.append('modelId', vals.modelId);
      formData.append('filePath', filePath);
      try {
        await api.axios.post('/api/embedWebClient:uploadModelFile', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        message.success(`${filePath} ${t('uploaded')}`);
        await fetchFileStatus();
      } catch (err: any) {
        message.error(`${t('Upload failed')}: ${err?.message}`);
      } finally {
        setUploadingFile(null);
      }
    },
    [api, form, fetchFileStatus, t],
  );

  return (
    <Modal
      title={t('Add Model')}
      open={open}
      onCancel={onClose}
      footer={[
        <Button key="close" onClick={onClose}>
          {t('Close')}
        </Button>,
        <Button key="done" type="primary" onClick={onDone}>
          {t('Done')}
        </Button>,
      ]}
      width={680}
      destroyOnClose
    >
      <Form form={form} layout="vertical" onValuesChange={fetchFileStatus}>
        <Row gutter={16}>
          <Col span={14}>
            <Form.Item
              name="modelId"
              label={t('Model ID')}
              rules={[{ required: true }]}
              extra="e.g. Xenova/bge-small-en-v1.5"
            >
              <Input placeholder="Org/model-name" />
            </Form.Item>
          </Col>
          <Col span={10}>
            <Form.Item name="dtype" label={t('Quantization')} initialValue="q8" rules={[{ required: true }]}>
              <Select options={Object.entries(DTYPE_LABELS).map(([v, l]) => ({ value: v, label: l }))} />
            </Form.Item>
          </Col>
        </Row>
      </Form>

      <Divider orientation="left">{t('Required Files')}</Divider>

      {loadingFiles ? (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      ) : fileStatuses.length === 0 ? (
        <Text type="secondary">{t('Enter Model ID and select quantization to see required files.')}</Text>
      ) : (
        <List
          size="small"
          dataSource={fileStatuses}
          renderItem={(f) => (
            <List.Item
              actions={[
                f.present ? (
                  <Tag color="success" icon={<CheckCircleOutlined />}>
                    {f.source}
                  </Tag>
                ) : (
                  <Upload
                    showUploadList={false}
                    beforeUpload={(file) => {
                      handleUploadFile(f.file, file as unknown as File);
                      return false;
                    }}
                  >
                    <Button size="small" icon={<CloudUploadOutlined />} loading={uploadingFile === f.file}>
                      {t('Upload')}
                    </Button>
                  </Upload>
                ),
              ]}
            >
              <Space>
                {f.present ? (
                  <CheckCircleOutlined style={{ color: '#52c41a' }} />
                ) : (
                  <CloseCircleOutlined style={{ color: '#ff4d4f' }} />
                )}
                <Text code>{f.file}</Text>
              </Space>
            </List.Item>
          )}
        />
      )}
    </Modal>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

export const ModelManager: React.FC = () => {
  const api = useAPIClient();
  const { t } = useTranslation('plugin-embed-web-client');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);

  const fetchModels = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request({ url: 'embedWebClient:listModels' });
      const data = res?.data?.data;
      setModels(Array.isArray(data) ? data : []);
    } catch {
      message.error(t('Failed to load models'));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  const handleDelete = async (modelId: string) => {
    try {
      await api.request({
        url: 'embedWebClient:deleteModel',
        method: 'post',
        data: { values: { modelId } },
      });
      message.success(t('Model deleted'));
      fetchModels();
    } catch (err: any) {
      message.error(`${t('Delete failed')}: ${err?.message}`);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={5} style={{ margin: 0 }}>
          {t('Installed Models')}
        </Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setUploadModalOpen(true)}>
          {t('Add Model')}
        </Button>
      </div>

      <Alert
        type="info"
        showIcon
        message={t(
          'Models are served from the NocoBase server — browsers load model files locally, no HuggingFace internet access required.',
        )}
        style={{ marginBottom: 16 }}
      />

      {loading ? (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
        </div>
      ) : models.length === 0 ? (
        <Text type="secondary">{t('No models installed.')}</Text>
      ) : (
        <Row gutter={[16, 16]}>
          {models.map((m) => (
            <Col span={12} key={m.modelId}>
              <Card
                size="small"
                title={
                  <Space>
                    <Text strong ellipsis style={{ maxWidth: 220 }}>
                      {m.modelId}
                    </Text>
                    {m.source === 'bundled' ? (
                      <Tag color="blue">{t('Bundled')}</Tag>
                    ) : (
                      <Tag color="green">{t('Uploaded')}</Tag>
                    )}
                  </Space>
                }
                extra={
                  m.source === 'uploaded' ? (
                    <Popconfirm title={t('Delete this model?')} onConfirm={() => handleDelete(m.modelId)}>
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  ) : (
                    <Tooltip title={t('Bundled models cannot be deleted')}>
                      <Button size="small" icon={<DeleteOutlined />} disabled />
                    </Tooltip>
                  )
                }
              >
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Space wrap>
                    {m.dimensions && <Tag>{m.dimensions}-dim</Tag>}
                    <Tag>{humanSize(m.fileSizeBytes)}</Tag>
                    {m.baseFilesReady ? (
                      <Tag color="success" icon={<CheckCircleOutlined />}>
                        {t('Ready')}
                      </Tag>
                    ) : (
                      <Tag color="error" icon={<ExclamationCircleOutlined />}>
                        {t('Incomplete')}
                      </Tag>
                    )}
                  </Space>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('Available dtypes')}:{' '}
                    {m.availableDtypes.map((d) => DTYPE_LABELS[d] ?? d).join(', ') || t('None')}
                  </Text>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      <UploadModelModal
        open={uploadModalOpen}
        onClose={() => setUploadModalOpen(false)}
        onDone={() => {
          setUploadModalOpen(false);
          fetchModels();
        }}
      />
    </div>
  );
};
