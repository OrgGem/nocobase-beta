import { useFlowContext } from '@nocobase/flow-engine';
import { Alert, Button, Card, Form, Select, message } from 'antd';
import React, { useEffect, useState } from 'react';

type PaginationMode = 'offset' | 'keyset' | 'cursor';

export default function PaginationSettingsPage() {
  const ctx = useFlowContext();
  const [form] = Form.useForm<{ paginationMode: PaginationMode }>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    async function loadSettings() {
      try {
        const response = await ctx.api.request({ url: 'databasePlusManager:getSettings', method: 'get' });
        form.setFieldsValue(response?.data ?? response);
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setLoading(false);
      }
    }

    loadSettings();
  }, [ctx.api, form]);

  async function save() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await ctx.api.request({ url: 'databasePlusManager:saveSettings', method: 'post', data: values });
      message.success('Pagination settings saved');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Pagination" loading={loading}>
      {error ? <Alert type="error" message={error} showIcon /> : null}
      <Form form={form} layout="vertical" initialValues={{ paginationMode: 'offset' }} style={{ maxWidth: 560 }}>
        <Form.Item name="paginationMode" label="Default pagination mode" rules={[{ required: true }]}>
          <Select
            options={[
              { value: 'offset', label: 'Default offset (compatible)' },
              { value: 'keyset', label: 'Keyset (opt-in API)' },
              { value: 'cursor', label: 'Cursor (opt-in API)' },
            ]}
          />
        </Form.Item>
        <Button type="primary" loading={saving} onClick={save}>
          Save
        </Button>
      </Form>
    </Card>
  );
}
