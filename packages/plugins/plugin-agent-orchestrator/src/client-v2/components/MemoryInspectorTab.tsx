import React, { useMemo, useState } from 'react';
import { Button, Card, Descriptions, Form, Input, Select, Space, Typography, message } from 'antd';
import { useApiClient, useRequest } from '../hooks/useApiRequest';
import { useAIEmployees } from './AIEmployeesContext';
import { useT } from '../skill-hub/locale';

type ProfileRecord = { tag: string; title?: string; enabled?: boolean };
type Preview = {
  context: string;
  appliedScopes: string[];
  chars: number;
  maxChars: number;
  harnessTag: string;
};
type PreviewForm = { userId: string; employeeUsername?: string; leaderUsername?: string; harnessTag?: string };

function responseRows<T>(value: unknown): T[] {
  const response = value as { data?: unknown } | undefined;
  return Array.isArray(response?.data) ? (response.data as T[]) : [];
}

function responseData<T>(value: unknown): T | undefined {
  const response = value as { data?: { data?: T } } | undefined;
  return response?.data?.data || (response?.data as unknown as T | undefined);
}

export const MemoryInspectorTab: React.FC = () => {
  const api = useApiClient();
  const t = useT();
  const { employees } = useAIEmployees();
  const [form] = Form.useForm<PreviewForm>();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const profilesRequest = useRequest({ url: 'agentHarnessProfiles:list', params: { pageSize: 100, sort: ['tag'] } });
  const profiles = useMemo(() => responseRows<ProfileRecord>(profilesRequest.data), [profilesRequest.data]);

  const createPreview = async (values: PreviewForm) => {
    setLoading(true);
    try {
      const response = await api.request({ url: 'agentKnowledgeInsights:memoryPreview', method: 'post', data: values });
      const data = responseData<Preview>(response.data);
      if (!data) throw new Error(t('Memory preview returned no data'));
      setPreview(data);
    } catch (error) {
      const detail = error as { response?: { data?: { errors?: Array<{ message?: string }> } }; message?: string };
      message.error(detail.response?.data?.errors?.[0]?.message || detail.message || t('Memory preview failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card bordered={false}>
        <Typography.Text type="secondary">
          {t(
            'Preview the exact memory context for a user and selected sub-agent before a run. Memory is marked as data, not executable instructions.',
          )}
        </Typography.Text>
        <Form
          form={form}
          layout="vertical"
          onFinish={createPreview}
          style={{ marginTop: 16, maxWidth: 680 }}
          initialValues={{ harnessTag: 'default' }}
        >
          <Form.Item label={t('User ID')} name="userId" rules={[{ required: true, message: t('User ID is required') }]}>
            <Input inputMode="numeric" />
          </Form.Item>
          <Form.Item label={t('Sub-Agent')} name="employeeUsername">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              options={employees.map((employee) => ({
                label: employee.nickname || employee.username,
                value: employee.username,
              }))}
            />
          </Form.Item>
          <Form.Item label={t('Leader (Orchestrator)')} name="leaderUsername">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              options={employees.map((employee) => ({
                label: employee.nickname || employee.username,
                value: employee.username,
              }))}
            />
          </Form.Item>
          <Form.Item label={t('Policy Profile')} name="harnessTag">
            <Select
              options={profiles
                .filter((profile) => profile.enabled !== false)
                .map((profile) => ({
                  label: profile.title ? `${profile.title} (${profile.tag})` : profile.tag,
                  value: profile.tag,
                }))}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={loading}>
            {t('Build memory preview')}
          </Button>
        </Form>
      </Card>
      {preview && (
        <Card title={t('Final memory context')}>
          <Descriptions bordered size="small" column={2} style={{ marginBottom: 16 }}>
            <Descriptions.Item label={t('Policy Profile')}>{preview.harnessTag}</Descriptions.Item>
            <Descriptions.Item label={t('Character budget')}>
              {preview.chars} / {preview.maxChars}
            </Descriptions.Item>
            <Descriptions.Item label={t('Applied scopes')} span={2}>
              {preview.appliedScopes.join(', ') || t('None')}
            </Descriptions.Item>
          </Descriptions>
          <Typography.Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {preview.context || t('No memory context matched this preview.')}
          </Typography.Paragraph>
        </Card>
      )}
    </Space>
  );
};
