/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useEffect } from 'react';
import { Form, Input, InputNumber, Select, Switch, Button, Space, Divider, Typography, Collapse, Row, Col } from 'antd';
import { useDocParserTranslation } from '../locale';

const { Text } = Typography;

export type ProviderFormValues = {
  title: string;
  enabled: boolean;
  apiEndpoint: string;
  authType: 'bearer' | 'api-key-header' | 'basic' | 'custom-headers' | 'none';
  apiKey?: string;
  authConfig?: {
    headerName?: string;
    username?: string;
    password?: string;
    customHeaders?: string; // JSON string in UI, parsed on save
  };
  requestFormat: 'multipart' | 'json-base64' | 'url';
  requestConfig?: {
    fileFieldName?: string;
    filenameFieldName?: string;
    mimetypeFieldName?: string;
    extraFields?: string; // JSON string
    base64FieldPath?: string;
    filenameFieldPath?: string;
    mimetypeFieldPath?: string;
    extraBody?: string; // JSON string
    urlFieldPath?: string;
  };
  responseTextPath?: string;
  timeout?: number;
  supportedMimetypes?: string[];
};

type Props = {
  initialValues?: Partial<ProviderFormValues>;
  onSubmit: (values: ProviderFormValues) => Promise<void>;
  onCancel: () => void;
  submitting?: boolean;
};

export const ProviderForm: React.FC<Props> = ({ initialValues, onSubmit, onCancel, submitting }) => {
  const { t } = useDocParserTranslation();
  const [form] = Form.useForm<ProviderFormValues>();
  const authType = Form.useWatch('authType', form);
  const requestFormat = Form.useWatch('requestFormat', form);

  useEffect(() => {
    if (initialValues) {
      form.setFieldsValue(initialValues);
    }
  }, [initialValues]);

  const handleSubmit = async () => {
    const values = await form.validateFields();
    await onSubmit(values);
  };

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={{
        enabled: true,
        authType: 'bearer',
        requestFormat: 'multipart',
        responseTextPath: 'text',
        timeout: 60000,
        requestConfig: { fileFieldName: 'file' },
        ...initialValues,
      }}
    >
      {/* ── Basic ──────────────────────────────────────────── */}
      <Row gutter={16}>
        <Col span={18}>
          <Form.Item name="title" label={t('Provider Title')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
        </Col>
        <Col span={6}>
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Col>
      </Row>

      <Form.Item name="apiEndpoint" label={t('API Endpoint')} rules={[{ required: true }]}>
        <Input placeholder="https://api.ocr-provider.com/v1/parse" />
      </Form.Item>

      {/* ── Auth ───────────────────────────────────────────── */}
      <Divider orientation="left" plain>
        {t('Auth Type')}
      </Divider>

      <Form.Item name="authType" label={t('Auth Type')}>
        <Select
          options={[
            { label: 'None', value: 'none' },
            { label: 'Bearer Token', value: 'bearer' },
            { label: 'API Key Header', value: 'api-key-header' },
            { label: 'Basic Auth', value: 'basic' },
            { label: 'Custom Headers', value: 'custom-headers' },
          ]}
          style={{ maxWidth: 260 }}
        />
      </Form.Item>

      {(authType === 'bearer' || authType === 'api-key-header') && (
        <Form.Item name="apiKey" label={t('API Key')}>
          <Input.Password />
        </Form.Item>
      )}

      {authType === 'api-key-header' && (
        <Form.Item name={['authConfig', 'headerName']} label={t('Header Name')}>
          <Input placeholder="X-Api-Key" style={{ maxWidth: 300 }} />
        </Form.Item>
      )}

      {authType === 'basic' && (
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name={['authConfig', 'username']} label={t('Username')}>
              <Input />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name={['authConfig', 'password']} label={t('Password')}>
              <Input.Password />
            </Form.Item>
          </Col>
        </Row>
      )}

      {authType === 'custom-headers' && (
        <Form.Item
          name={['authConfig', 'customHeaders']}
          label={t('Custom Headers')}
          help={<Text type="secondary">JSON: {'{"X-Tenant": "abc", "X-Secret": "xxx"}'}</Text>}
          rules={[
            {
              validator: (_, value) => {
                if (!value) return Promise.resolve();
                try {
                  JSON.parse(value);
                  return Promise.resolve();
                } catch {
                  return Promise.reject(new Error('Must be valid JSON'));
                }
              },
            },
          ]}
        >
          <Input.TextArea rows={3} placeholder='{"X-Tenant": "abc"}' />
        </Form.Item>
      )}

      {/* ── Request format ─────────────────────────────────── */}
      <Divider orientation="left" plain>
        {t('Request Format')}
      </Divider>

      <Form.Item name="requestFormat" label={t('Request Format')}>
        <Select
          options={[
            { label: t('Multipart Form Data'), value: 'multipart' },
            { label: t('JSON Base64'), value: 'json-base64' },
            { label: 'URL (provider fetches)', value: 'url' },
          ]}
          style={{ maxWidth: 260 }}
        />
      </Form.Item>

      {requestFormat === 'multipart' && (
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item name={['requestConfig', 'fileFieldName']} label={t('Form Field Name')}>
              <Input placeholder="file" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name={['requestConfig', 'filenameFieldName']} label={t('Filename Field Path')}>
              <Input placeholder="(optional)" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name={['requestConfig', 'mimetypeFieldName']} label={t('Mimetype Field Path')}>
              <Input placeholder="(optional)" />
            </Form.Item>
          </Col>
        </Row>
      )}

      {requestFormat === 'json-base64' && (
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item name={['requestConfig', 'base64FieldPath']} label={t('Base64 Field Path')}>
              <Input placeholder="file" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name={['requestConfig', 'filenameFieldPath']} label={t('Filename Field Path')}>
              <Input placeholder="filename" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name={['requestConfig', 'mimetypeFieldPath']} label={t('Mimetype Field Path')}>
              <Input placeholder="mimetype" />
            </Form.Item>
          </Col>
        </Row>
      )}

      {requestFormat === 'url' && (
        <Form.Item name={['requestConfig', 'urlFieldPath']} label={t('URL Field Path')}>
          <Input placeholder="url" style={{ maxWidth: 300 }} />
        </Form.Item>
      )}

      <Collapse
        ghost
        items={[
          {
            key: 'extra',
            label: t('Extra Request Body'),
            children: (
              <Form.Item
                name={['requestConfig', requestFormat === 'multipart' ? 'extraFields' : 'extraBody']}
                help={<Text type="secondary">JSON object — merged into request body/fields</Text>}
                rules={[
                  {
                    validator: (_, value) => {
                      if (!value) return Promise.resolve();
                      try {
                        JSON.parse(value);
                        return Promise.resolve();
                      } catch {
                        return Promise.reject(new Error('Must be valid JSON'));
                      }
                    },
                  },
                ]}
              >
                <Input.TextArea rows={4} placeholder='{"lang": "vie+eng"}' />
              </Form.Item>
            ),
          },
        ]}
      />

      {/* ── Response ───────────────────────────────────────── */}
      <Divider orientation="left" plain>
        Response
      </Divider>

      <Row gutter={16}>
        <Col span={16}>
          <Form.Item
            name="responseTextPath"
            label={t('Response Text Path')}
            help={
              <Text type="secondary">Dot-path, e.g. &quot;data.text&quot; or &quot;result.pages.0.content&quot;</Text>
            }
          >
            <Input placeholder="text" />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item name="timeout" label={t('Timeout (ms)')}>
            <InputNumber min={1000} step={5000} style={{ width: '100%' }} />
          </Form.Item>
        </Col>
      </Row>

      {/* ── Scope ──────────────────────────────────────────── */}
      <Divider orientation="left" plain>
        Scope
      </Divider>

      <Form.Item
        name="supportedMimetypes"
        label={t('Supported MIME Types')}
        help={t('Leave empty to handle all non-image types')}
      >
        <Select
          mode="tags"
          tokenSeparators={[',']}
          placeholder="application/pdf, application/vnd.openxmlformats..."
          style={{ width: '100%' }}
          options={[
            { label: 'PDF', value: 'application/pdf' },
            { label: 'DOCX', value: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
            { label: 'XLSX', value: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
            { label: 'PPTX', value: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
            { label: 'Plain text', value: 'text/plain' },
            { label: 'HTML', value: 'text/html' },
          ]}
        />
      </Form.Item>

      {/* ── Actions ────────────────────────────────────────── */}
      <Form.Item style={{ marginBottom: 0, marginTop: 24 }}>
        <Space>
          <Button type="primary" onClick={handleSubmit} loading={submitting}>
            Save
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </Space>
      </Form.Item>
    </Form>
  );
};
