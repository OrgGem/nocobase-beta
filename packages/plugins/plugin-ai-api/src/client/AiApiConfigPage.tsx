/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useEffect, useState } from 'react';
import { Card, Form, Select, InputNumber, Button, message, Typography, Space, Alert, Divider, Spin, Radio } from 'antd';
import { useApp } from '@nocobase/client-v2';

const { Title, Text, Paragraph } = Typography;

interface AiApiConfig {
  mode: string;
  defaultAiEmployee: string;
  defaultLlmService: string;
  enabledLlmServices: string[];
  rateLimitPerMinute: number;
}

interface AiEmployee {
  username: string;
  nickname: string;
}

interface LlmService {
  name: string;
  title: string;
  provider: string;
  enabled: boolean;
}

export function AiApiConfigPage() {
  const api = useApp().apiClient;
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [employees, setEmployees] = useState<AiEmployee[]>([]);
  const [services, setServices] = useState<LlmService[]>([]);
  const [baseUrl, setBaseUrl] = useState('');

  useEffect(() => {
    loadData();
    setBaseUrl(`${window.location.origin}/api/ai-llm/v1`);
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      // Load config
      const configRes = await api.request({ url: 'aiApiConfig:get' });
      const config = configRes?.data?.data;
      if (config) {
        form.setFieldsValue({
          mode: config.mode || 'llm',
          defaultAiEmployee: config.defaultAiEmployee || undefined,
          defaultLlmService: config.defaultLlmService || undefined,
          enabledLlmServices: config.enabledLlmServices || [],
          rateLimitPerMinute: config.rateLimitPerMinute || 60,
        });
      }

      // Load AI employees
      const empRes = await api.request({
        url: 'aiEmployees:list',
        params: { paginate: false },
      });
      setEmployees(
        (empRes?.data?.data || []).map((e: any) => ({
          username: e.username,
          nickname: e.nickname || e.username,
        })),
      );

      // Load LLM services
      const svcRes = await api.request({
        url: 'ai:listLLMServices',
      });
      setServices(
        (svcRes?.data?.data || []).map((s: any) => ({
          name: s.name,
          title: s.title || s.name,
          provider: s.provider,
          enabled: s.enabled !== false,
        })),
      );
    } catch (err) {
      console.error('Failed to load config:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const values = form.getFieldsValue();
      await api.request({
        url: 'aiApiConfig:save',
        method: 'post',
        data: values,
      });
      message.success('Configuration saved');
    } catch (err) {
      message.error('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '24px 0' }}>
      <Title level={3}>AI API Gateway Configuration</Title>
      <Paragraph type="secondary">
        Configure the OpenAI-compatible API endpoint. External applications can connect using the base URL and a
        NocoBase API key.
      </Paragraph>

      <Card style={{ marginBottom: 24 }}>
        <Alert
          type="info"
          showIcon
          message="API Endpoint"
          description={
            <Space direction="vertical" size={4}>
              <Text>
                Base URL:{' '}
                <Text code copyable>
                  {baseUrl}
                </Text>
              </Text>
              <Text type="secondary">
                Use this as the base URL in any OpenAI-compatible client (Cursor, Continue.dev, n8n, etc.)
              </Text>
            </Space>
          }
          style={{ marginBottom: 16 }}
        />

        <Alert
          type="warning"
          showIcon
          message="Authentication"
          description={
            <Text>
              Clients must include a NocoBase API key as a Bearer token:
              <br />
              <Text code>Authorization: Bearer {'<your-nocobase-api-key>'}</Text>
              <br />
              <Text type="secondary">API keys can be created in Settings → API keys.</Text>
            </Text>
          }
        />
      </Card>

      <Card title="Configuration">
        <Form form={form} layout="vertical" onFinish={handleSave} initialValues={{ mode: 'llm' }}>
          <Form.Item
            name="mode"
            label="API Mode"
            tooltip="LLM Proxy: Direct access to the LLM model. Agent: Full AI Employee with tools, knowledge base, and agent capabilities."
          >
            <Radio.Group>
              <Radio.Button value="llm">LLM Proxy</Radio.Button>
              <Radio.Button value="agent">AI Employee Agent</Radio.Button>
            </Radio.Group>
          </Form.Item>

          <Form.Item
            name="defaultAiEmployee"
            label="Default AI Employee"
            tooltip="The AI Employee whose system prompt will be injected into chat completions (when client doesn't provide a system message)"
          >
            <Select
              allowClear
              placeholder="Select an AI Employee (optional)"
              options={employees.map((e) => ({
                label: `${e.nickname} (${e.username})`,
                value: e.username,
              }))}
            />
          </Form.Item>

          <Form.Item
            name="defaultLlmService"
            label="Default LLM Service"
            tooltip="The LLM service used when clients send only a model name (e.g. 'gpt-4o') without a service prefix. This is the main service that powers the API."
            rules={[{ required: true, message: 'Please select a default LLM service' }]}
          >
            <Select
              allowClear
              placeholder="Select an LLM Service"
              options={services.map((s) => ({
                label: `${s.title} (${s.provider})`,
                value: s.name,
              }))}
            />
          </Form.Item>

          <Form.Item
            name="enabledLlmServices"
            label="Enabled LLM Services"
            tooltip="Only these services will be exposed via the API. Leave empty to expose all enabled services."
          >
            <Select
              mode="multiple"
              allowClear
              placeholder="All enabled services (default)"
              options={services.map((s) => ({
                label: `${s.title} (${s.provider})`,
                value: s.name,
              }))}
            />
          </Form.Item>

          <Form.Item
            name="rateLimitPerMinute"
            label="Rate Limit (requests/minute)"
            tooltip="Maximum API requests per user per minute. Set 0 for unlimited."
          >
            <InputNumber min={0} max={10000} style={{ width: 200 }} />
          </Form.Item>

          <Form.Item>
            <Button type="primary" htmlType="submit" loading={saving}>
              Save Configuration
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card title="Quick Start" style={{ marginTop: 24 }}>
        <Title level={5}>cURL Example</Title>
        <Paragraph>
          <pre
            style={{
              background: '#1a1a2e',
              color: '#e0e0e0',
              padding: 16,
              borderRadius: 8,
              fontSize: 13,
              overflow: 'auto',
            }}
          >{`curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer <your-api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "<service-name>/<model-id>",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'`}</pre>
        </Paragraph>

        <Title level={5}>Python (OpenAI SDK)</Title>
        <Paragraph>
          <pre
            style={{
              background: '#1a1a2e',
              color: '#e0e0e0',
              padding: 16,
              borderRadius: 8,
              fontSize: 13,
              overflow: 'auto',
            }}
          >{`from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="<your-nocobase-api-key>"
)

response = client.chat.completions.create(
    model="<service-name>/<model-id>",
    messages=[{"role": "user", "content": "Hello!"}]
)`}</pre>
        </Paragraph>

        <Title level={5}>List Available Models</Title>
        <Paragraph>
          <pre
            style={{
              background: '#1a1a2e',
              color: '#e0e0e0',
              padding: 16,
              borderRadius: 8,
              fontSize: 13,
              overflow: 'auto',
            }}
          >{`curl ${baseUrl}/models \\
  -H "Authorization: Bearer <your-api-key>"`}</pre>
        </Paragraph>
      </Card>
    </div>
  );
}

export default AiApiConfigPage;
