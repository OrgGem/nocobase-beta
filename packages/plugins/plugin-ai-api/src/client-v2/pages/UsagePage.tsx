import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useFlowContext } from '@nocobase/flow-engine';
import { useT } from '../locale';
import { errorMessage, unwrapData } from './api';

interface UsageRecord {
  id: string | number;
  requestId: string;
  userId: string | number;
  model?: string;
  resolvedService?: string;
  resolvedModel?: string;
  status: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCost?: string;
  currency?: string;
  costStatus?: string;
  startedAt?: string;
}

interface UsageFilters {
  range: [Dayjs, Dayjs];
  userId?: number;
  resolvedService?: string;
  resolvedModel?: string;
  status?: string;
}

interface UsageSummary {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costsByCurrency: { currency: string; totalCost: string }[];
}

interface LlmService {
  name: string;
  title?: string;
}

const initialRange = (): [Dayjs, Dayjs] => [dayjs().subtract(29, 'day').startOf('day'), dayjs().endOf('day')];
const emptySummary: UsageSummary = {
  requestCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costsByCurrency: [],
};

export default function UsagePage() {
  const ctx = useFlowContext();
  const t = useT();
  const [form] = Form.useForm<UsageFilters>();
  const [rows, setRows] = useState<UsageRecord[]>([]);
  const [summary, setSummary] = useState<UsageSummary>(emptySummary);
  const [services, setServices] = useState<LlmService[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (override?: UsageFilters) => {
      const values = override ?? form.getFieldsValue();
      const [start, end] = values.range ?? initialRange();
      const conditions: Record<string, unknown>[] = [
        { startedAt: { $gte: start.toISOString(), $lte: end.toISOString() } },
      ];
      if (values.userId !== undefined) conditions.push({ userId: values.userId });
      if (values.resolvedService) conditions.push({ resolvedService: values.resolvedService });
      if (values.resolvedModel) conditions.push({ resolvedModel: values.resolvedModel });
      if (values.status) conditions.push({ status: values.status });
      const summaryParams = {
        start: start.toISOString(),
        end: end.toISOString(),
        userId: values.userId,
        resolvedService: values.resolvedService,
        resolvedModel: values.resolvedModel,
        status: values.status,
      };

      setLoading(true);
      try {
        const [recordsResponse, summaryResponse] = await Promise.all([
          ctx.api.request({
            url: 'aiApiUsageRecords:list',
            method: 'get',
            params: { pageSize: 100, sort: '-startedAt', filter: { $and: conditions } },
          }),
          ctx.api.request({ url: 'aiApiUsageMonitor:summary', method: 'get', params: summaryParams }),
        ]);
        setRows(unwrapData<UsageRecord[]>(recordsResponse, []));
        setSummary(unwrapData<UsageSummary>(summaryResponse, emptySummary));
      } catch (error) {
        message.error(errorMessage(error));
      } finally {
        setLoading(false);
      }
    },
    [ctx.api, form],
  );

  useEffect(() => {
    const range = initialRange();
    form.setFieldsValue({ range });
    load({ range });
    ctx.api
      .request({ url: 'ai:listLLMServices', method: 'get' })
      .then((response) => setServices(unwrapData<LlmService[]>(response, [])))
      .catch((error: unknown) => message.error(errorMessage(error)));
  }, [ctx.api, form, load]);

  const reset = () => {
    const range = initialRange();
    form.setFieldsValue({
      range,
      userId: undefined,
      resolvedService: undefined,
      resolvedModel: undefined,
      status: undefined,
    });
    load({ range });
  };

  const totalCost = summary.costsByCurrency.length
    ? summary.costsByCurrency.map((item) => `${item.totalCost} ${item.currency}`).join(' + ')
    : '0';

  const columns: ColumnsType<UsageRecord> = [
    { title: t('Started at'), dataIndex: 'startedAt', key: 'startedAt', width: 180 },
    { title: t('User'), dataIndex: 'userId', key: 'userId', width: 90 },
    { title: t('Requested model'), dataIndex: 'model', key: 'model', width: 170 },
    { title: t('Resolved service'), dataIndex: 'resolvedService', key: 'resolvedService', width: 170 },
    { title: t('Resolved model'), dataIndex: 'resolvedModel', key: 'resolvedModel', width: 170 },
    { title: t('Input tokens'), dataIndex: 'inputTokens', key: 'inputTokens', width: 110 },
    { title: t('Output tokens'), dataIndex: 'outputTokens', key: 'outputTokens', width: 110 },
    { title: t('Total tokens'), dataIndex: 'totalTokens', key: 'totalTokens', width: 110 },
    {
      title: t('Cost'),
      key: 'cost',
      width: 130,
      render: (_, record) => (record.estimatedCost == null ? '-' : `${record.estimatedCost} ${record.currency ?? ''}`),
    },
    {
      title: t('Cost status'),
      dataIndex: 'costStatus',
      key: 'costStatus',
      width: 130,
      render: (status?: string) => (status ? <Tag>{status}</Tag> : '-'),
    },
    { title: t('Status'), dataIndex: 'status', key: 'status', width: 100 },
    { title: t('Request ID'), dataIndex: 'requestId', key: 'requestId', width: 240 },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title={t('Usage filters')} size="small">
        <Form form={form} layout="inline" onFinish={(values) => load(values)}>
          <Form.Item name="range" label={t('Time range')} rules={[{ required: true }]}>
            <DatePicker.RangePicker showTime />
          </Form.Item>
          <Form.Item name="userId" label={t('User ID')}>
            <InputNumber min={1} style={{ width: 110 }} />
          </Form.Item>
          <Form.Item name="resolvedService" label={t('Resolved service')}>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: 190 }}
              options={services.map((service) => ({ label: service.title || service.name, value: service.name }))}
            />
          </Form.Item>
          <Form.Item name="resolvedModel" label={t('Resolved model')}>
            <Input allowClear style={{ width: 180 }} />
          </Form.Item>
          <Form.Item name="status" label={t('Status')}>
            <Select
              allowClear
              style={{ width: 130 }}
              options={[
                { label: t('Succeeded'), value: 'succeeded' },
                { label: t('Failed'), value: 'failed' },
                { label: t('Started'), value: 'started' },
              ]}
            />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" loading={loading}>
                {t('Apply filters')}
              </Button>
              <Button onClick={reset}>{t('Reset')}</Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic title={t('Requests')} value={summary.requestCount} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic title={t('Input tokens')} value={summary.inputTokens} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic title={t('Output tokens')} value={summary.outputTokens} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic title={t('Total tokens')} value={summary.totalTokens} />
          </Card>
        </Col>
        <Col xs={24}>
          <Card size="small">
            <Statistic title={t('Total cost')} value={totalCost} />
          </Card>
        </Col>
      </Row>
      <Card title={t('Usage records')} extra={<Button onClick={() => load()}>{t('Refresh')}</Button>}>
        <Table rowKey="id" columns={columns} dataSource={rows} loading={loading} scroll={{ x: 1600 }} />
      </Card>
    </Space>
  );
}
