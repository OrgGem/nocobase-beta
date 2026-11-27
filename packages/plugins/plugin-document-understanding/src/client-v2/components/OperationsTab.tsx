// SPDX-License-Identifier: Apache-2.0

import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Upload,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { UploadFile } from 'antd/es/upload/interface';
import {
  CheckOutlined,
  EyeOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useFlowContext } from '@nocobase/flow-engine';
import { DU_BUSINESS_CATALOG, DU_OPERATION_STATES, parsePageRangeString } from '../../server/contracts/du-contracts';
import { useT } from '../locale';
import { OperationView, UsageSummaryView, errorMessage, formatDateTime, unwrapData } from '../types';

const { TextArea } = Input;

const STATE_COLORS: Record<string, string> = {
  PENDING_INGESTION: 'default',
  ACCEPTED: 'cyan',
  QUEUED: 'blue',
  RUNNING: 'processing',
  WAITING_CHILDREN: 'processing',
  WAITING_INPUT: 'warning',
  RETRY_PENDING: 'orange',
  CANCEL_REQUESTED: 'orange',
  SUCCEEDED: 'success',
  FAILED: 'error',
  CANCELLED: 'default',
  TIMED_OUT: 'error',
};

interface DetailedOperation extends OperationView {
  outputPayload?: Record<string, unknown> | null;
  resultEnvelope?: Record<string, unknown> | null;
}

export const OperationsTab: React.FC = () => {
  const ctx = useFlowContext();
  const api = ctx.api;
  const t = useT();

  const [operations, setOperations] = useState<OperationView[]>([]);
  const [usageSummary, setUsageSummary] = useState<UsageSummaryView | null>(null);
  const [loading, setLoading] = useState(false);
  const [filterState, setFilterState] = useState<string>();
  const [filterBusiness, setFilterBusiness] = useState<string>();

  const [runVisible, setRunVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [runForm] = Form.useForm();
  const [uploadFiles, setUploadFiles] = useState<UploadFile[]>([]);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeOp, setActiveOp] = useState<DetailedOperation | null>(null);

  const [resumeOpen, setResumeOpen] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeForm] = Form.useForm();

  const watchedBusiness = Form.useWatch('businessId', runForm) || 'document-core';
  const watchedAction = Form.useWatch('action', runForm) || 'extract';

  const fetchOperations = useCallback(async () => {
    setLoading(true);
    try {
      const filter: Record<string, string> = {};
      if (filterState) filter.state = filterState;
      if (filterBusiness) filter.businessId = filterBusiness;

      const [opsRes, usageRes] = await Promise.all([
        api.request({
          url: 'docUnderstanding:listOperations',
          params: { filter: Object.keys(filter).length > 0 ? filter : undefined },
        }),
        api.request({ url: 'docUnderstanding:getUsageSummary' }).catch(() => null),
      ]);
      setOperations(unwrapData<OperationView[]>(opsRes, []));
      if (usageRes) {
        setUsageSummary(unwrapData<UsageSummaryView | null>(usageRes, null));
      }
    } finally {
      setLoading(false);
    }
  }, [api, filterState, filterBusiness]);

  useEffect(() => {
    fetchOperations();
    const timer = setInterval(fetchOperations, 8000);
    return () => clearInterval(timer);
  }, [fetchOperations]);

  const openOperationDetails = async (operationId: string) => {
    try {
      const res = await api.request({
        url: 'docUnderstanding:getOperation',
        params: { filterByTk: operationId },
      });
      setActiveOp(unwrapData<DetailedOperation | null>(res, null));
      setDrawerOpen(true);
    } catch (err) {
      message.error(errorMessage(err));
    }
  };

  const handleCancelOperation = async (operationId: string) => {
    try {
      await api.request({
        url: 'docUnderstanding:cancelOperation',
        method: 'POST',
        params: { filterByTk: operationId },
      });
      message.success(t('Operation cancellation requested'));
      fetchOperations();
      if (activeOp?.id === operationId) {
        openOperationDetails(operationId);
      }
    } catch (err) {
      message.error(errorMessage(err));
    }
  };

  const openResumeModal = (op: OperationView) => {
    setActiveOp(op);
    resumeForm.setFieldsValue({
      approved: true,
      note: '',
    });
    setResumeOpen(true);
  };

  const handleResumeSubmit = async () => {
    if (!activeOp) return;
    setResuming(true);
    try {
      const values = await resumeForm.validateFields();
      await api.request({
        url: 'docUnderstanding:resumeOperation',
        method: 'POST',
        params: { filterByTk: activeOp.id },
        data: {
          waitId: activeOp.wait?.waitId,
          expectedStateVersion: activeOp.stateVersion,
          input: values,
        },
      });
      message.success(t('Operation resumed'));
      setResumeOpen(false);
      fetchOperations();
      openOperationDetails(activeOp.id);
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setResuming(false);
    }
  };

  const handleRunOperation = async () => {
    setSubmitting(true);
    try {
      const values = await runForm.validateFields();
      const extraInput = values.inputJson?.trim() ? (JSON.parse(values.inputJson) as Record<string, unknown>) : {};
      const catalogMatch = DU_BUSINESS_CATALOG.find(
        (c) =>
          c.businessId === values.businessId &&
          c.action === values.action &&
          (!values.variant || c.discriminatorValue === values.variant),
      );
      if (catalogMatch?.discriminatorField && values.variant) {
        extraInput[catalogMatch.discriminatorField] = values.variant;
      }
      if (values.pages?.trim()) {
        // Validate page range syntax client-side before submitting
        parsePageRangeString(values.pages);
        extraInput.pages = values.pages.trim();
      }

      const formData = new FormData();
      formData.append('businessId', values.businessId);
      formData.append('action', values.action);
      formData.append('input', JSON.stringify(extraInput));
      for (const fileItem of uploadFiles) {
        if (fileItem.originFileObj) {
          formData.append('files', fileItem.originFileObj, fileItem.name);
        }
      }

      const res = await api.request({
        url: 'docUnderstanding:submitOperation',
        method: 'POST',
        data: formData,
      });
      const created = unwrapData<{ operationId?: string }>(res, {});
      message.success(`${t('Operation submitted')}: ${created.operationId || ''}`);
      setRunVisible(false);
      setUploadFiles([]);
      fetchOperations();
      if (created.operationId) {
        openOperationDetails(created.operationId);
      }
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const actionsForBusiness = Array.from(
    new Set(DU_BUSINESS_CATALOG.filter((c) => c.businessId === watchedBusiness).map((c) => c.action)),
  );
  const variantsForAction = DU_BUSINESS_CATALOG.filter(
    (c) => c.businessId === watchedBusiness && c.action === watchedAction && c.discriminatorValue,
  );

  const columns: ColumnsType<OperationView> = [
    {
      title: t('Operation ID'),
      dataIndex: 'id',
      width: 150,
      render: (id: string) => <code style={{ fontSize: 11 }}>{id.slice(0, 12)}...</code>,
    },
    {
      title: t('Business / Action'),
      width: 190,
      render: (_: unknown, record) => (
        <Space size={4}>
          <Tag color="geekblue">{record.businessId}</Tag>
          <span>{record.action}</span>
        </Space>
      ),
    },
    {
      title: t('State'),
      dataIndex: 'state',
      width: 150,
      render: (state: string) => <Tag color={STATE_COLORS[state] || 'default'}>{state}</Tag>,
    },
    {
      title: t('Progress'),
      width: 130,
      render: (_: unknown, record) => <Progress percent={record.progress?.percent ?? 0} size="small" />,
    },
    {
      title: t('Tokens / Cost'),
      width: 150,
      render: (_: unknown, record) =>
        record.usage ? (
          <span style={{ fontSize: 12 }}>
            {record.usage.inputTokens + record.usage.outputTokens} tok ($
            {(record.usage.costMicrousd / 1_000_000).toFixed(4)})
          </span>
        ) : (
          '-'
        ),
    },
    {
      title: t('Created'),
      dataIndex: 'createdAt',
      width: 165,
      render: (v: string) => formatDateTime(v),
    },
    {
      title: t('Action'),
      width: 210,
      render: (_: unknown, record) => {
        const isTerminal = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(record.state);
        return (
          <Space size={4}>
            <Button
              size="small"
              icon={<EyeOutlined />}
              onClick={() => openOperationDetails(record.id)}
              aria-label={`${t('View')} ${record.id}`}
            >
              {t('View')}
            </Button>
            {record.state === 'WAITING_INPUT' && (
              <Button
                size="small"
                type="primary"
                icon={<CheckOutlined />}
                onClick={() => openResumeModal(record)}
                aria-label={`${t('Approve / Resume')} ${record.id}`}
              >
                {t('Resume')}
              </Button>
            )}
            {!isTerminal && (
              <Popconfirm title={t('Cancel this operation?')} onConfirm={() => handleCancelOperation(record.id)}>
                <Button size="small" danger icon={<StopOutlined />} aria-label={`${t('Cancel')} ${record.id}`} />
              </Popconfirm>
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      {usageSummary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
          <Card size="small">
            <Statistic title={t('Operations (30d)')} value={usageSummary.totalOperations} />
          </Card>
          <Card size="small">
            <Statistic title={t('Input Tokens')} value={usageSummary.inputTokens} />
          </Card>
          <Card size="small">
            <Statistic title={t('Output Tokens')} value={usageSummary.outputTokens} />
          </Card>
          <Card size="small">
            <Statistic
              title={t('Estimated Cost (USD)')}
              value={(usageSummary.costMicrousd / 1_000_000).toFixed(4)}
              prefix="$"
            />
          </Card>
        </div>
      )}

      <Space style={{ marginBottom: 16 }} wrap>
        <Button
          type="primary"
          icon={<PlayCircleOutlined />}
          onClick={() => {
            runForm.resetFields();
            setUploadFiles([]);
            setRunVisible(true);
          }}
        >
          {t('Run Business Action')}
        </Button>
        <Select
          allowClear
          placeholder={t('Filter by state')}
          aria-label={t('Filter by state')}
          value={filterState}
          onChange={setFilterState}
          style={{ width: 180 }}
          options={DU_OPERATION_STATES.map((s) => ({ value: s, label: s }))}
        />
        <Select
          allowClear
          placeholder={t('Filter by business')}
          aria-label={t('Filter by business')}
          value={filterBusiness}
          onChange={setFilterBusiness}
          style={{ width: 180 }}
          options={[
            { value: 'document-core', label: 'document-core' },
            { value: 'lc-checker', label: 'lc-checker' },
            { value: 'example-review', label: 'example-review' },
          ]}
        />
        <Button icon={<ReloadOutlined />} onClick={fetchOperations}>
          {t('Refresh')}
        </Button>
      </Space>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={operations}
        loading={loading}
        size="small"
        pagination={{ pageSize: 15 }}
      />

      {/* Run Canonical Business Action Modal */}
      <Modal
        title={t('Run Document Understanding Action')}
        open={runVisible}
        onOk={handleRunOperation}
        onCancel={() => setRunVisible(false)}
        confirmLoading={submitting}
        okText={t('Submit Operation')}
        cancelText={t('Cancel')}
        width={640}
        destroyOnClose
      >
        <Form
          form={runForm}
          layout="vertical"
          initialValues={{ businessId: 'document-core', action: 'extract', variant: 'invoice', inputJson: '{}' }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <Form.Item name="businessId" label={t('Business')} rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'document-core', label: 'document-core (v2.0.0)' },
                  { value: 'lc-checker', label: 'lc-checker (v1.2.0)' },
                  { value: 'example-review', label: 'example-review (v1.0.0)' },
                ]}
              />
            </Form.Item>
            <Form.Item name="action" label={t('Action')} rules={[{ required: true }]}>
              <Select options={actionsForBusiness.map((act) => ({ value: act, label: act }))} />
            </Form.Item>
          </div>

          {variantsForAction.length > 0 && (
            <Form.Item name="variant" label={t('Variant / Mode')}>
              <Select
                options={variantsForAction.map((v) => ({
                  value: v.discriminatorValue as string,
                  label: `${v.discriminatorValue} — ${v.description}`,
                }))}
              />
            </Form.Item>
          )}

          <Form.Item label={t('Upload Input Documents')}>
            <Upload
              multiple
              beforeUpload={() => false}
              fileList={uploadFiles}
              onChange={({ fileList }) => setUploadFiles(fileList)}
            >
              <Button icon={<UploadOutlined />}>{t('Select Files')}</Button>
            </Upload>
          </Form.Item>

          <Form.Item
            name="pages"
            label={t('Page Selection (DI-06)')}
            help={t('Optional page ranges, e.g. "1-2, 5" (leave blank for all pages)')}
          >
            <Input placeholder="1-2" />
          </Form.Item>

          <Form.Item name="inputJson" label={t('Input JSON')}>
            <TextArea rows={4} style={{ fontFamily: 'monospace', fontSize: 12 }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Human-in-the-Loop WAITING_INPUT Approval Modal */}
      <Modal
        title={`${t('Human-in-the-Loop Approval')} — ${activeOp?.id.slice(0, 12) || ''}`}
        open={resumeOpen}
        onOk={handleResumeSubmit}
        onCancel={() => setResumeOpen(false)}
        confirmLoading={resuming}
        okText={t('Submit Decision')}
        cancelText={t('Cancel')}
        destroyOnClose
      >
        {activeOp?.wait?.prompt && (
          <Alert message={activeOp.wait.prompt} type="warning" showIcon style={{ marginBottom: 16 }} />
        )}
        {activeOp?.wait?.previewData !== undefined && (
          <pre
            style={{
              background: '#fafafa',
              padding: 10,
              borderRadius: 6,
              maxHeight: 200,
              overflow: 'auto',
              fontSize: 11,
              marginBottom: 16,
            }}
          >
            {JSON.stringify(activeOp.wait.previewData, null, 2)}
          </pre>
        )}
        <Form form={resumeForm} layout="vertical" initialValues={{ approved: true }}>
          <Form.Item name="approved" label={t('Approve & Proceed')} valuePropName="checked">
            <Switch checkedChildren={t('Approve')} unCheckedChildren={t('Reject')} />
          </Form.Item>
          <Form.Item name="note" label={t('Reviewer Note')}>
            <TextArea rows={3} placeholder={t('Enter verification note...')} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Operation Details Drawer */}
      <Drawer
        title={activeOp ? `${t('Operation')} ${activeOp.id}` : t('Operation Details')}
        width={680}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      >
        {activeOp && (
          <div>
            <Space wrap style={{ marginBottom: 16 }}>
              <Tag color={STATE_COLORS[activeOp.state] || 'default'}>{activeOp.state}</Tag>
              <Tag color="geekblue">
                {activeOp.businessId}@{activeOp.businessVersion} / {activeOp.action}
              </Tag>
              <span>v{activeOp.stateVersion}</span>
              {activeOp.state === 'WAITING_INPUT' && (
                <Button size="small" type="primary" onClick={() => openResumeModal(activeOp)}>
                  {t('Approve / Resume')}
                </Button>
              )}
            </Space>

            {activeOp.outputPayload?.humanSignOffRequired === true && (
              <Alert
                type="warning"
                showIcon
                message={t('Human Sign-off Required (Trade Finance L/C Policy)')}
                description={t('Automated UCP 600 / ISBP 821 findings require an authorized specialist signature.')}
                style={{ marginBottom: 16 }}
              />
            )}

            {activeOp.error && (
              <Alert
                type="error"
                showIcon
                message={`${activeOp.error.code}: ${activeOp.error.title}`}
                description={activeOp.error.detail}
                style={{ marginBottom: 16 }}
              />
            )}

            {activeOp.usage && (
              <>
                <h4>{t('Token & Cost Usage')}</h4>
                <pre style={{ background: '#f5f5f5', padding: 10, borderRadius: 6, fontSize: 12 }}>
                  {JSON.stringify(activeOp.usage, null, 2)}
                </pre>
              </>
            )}

            {activeOp.documentInputCoverage && (
              <>
                <h4>{t('Document Input Coverage (DI-06)')}</h4>
                <pre
                  style={{
                    background: '#f5f5f5',
                    padding: 10,
                    borderRadius: 6,
                    fontSize: 11,
                    maxHeight: 160,
                    overflow: 'auto',
                  }}
                >
                  {JSON.stringify(activeOp.documentInputCoverage, null, 2)}
                </pre>
              </>
            )}

            <h4>{t('Output Payload')}</h4>
            <pre
              style={{
                background: '#f0f5ff',
                padding: 12,
                borderRadius: 6,
                fontSize: 12,
                maxHeight: 360,
                overflow: 'auto',
              }}
            >
              {activeOp.outputPayload ? JSON.stringify(activeOp.outputPayload, null, 2) : t('(not yet available)')}
            </pre>
          </div>
        )}
      </Drawer>
    </div>
  );
};
