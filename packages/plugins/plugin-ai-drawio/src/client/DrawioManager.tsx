import React, { useEffect, useMemo, useState } from 'react';
import { Tabs, Card, Button, Form, Input, Table, Space, Modal, App as AntApp, Typography, Drawer } from 'antd';
import { useAPIClient, useRequest } from '@nocobase/client';
import { useT } from './locale';
import { DrawioBlock } from './DrawioBlock';

const { Text } = Typography;

const SettingsTab: React.FC = () => {
  const t = useT();
  const api = useAPIClient();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const { data, refresh, loading } = useRequest<any>({ resource: 'aiDrawio', action: 'getConfig' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    form.setFieldsValue({ drawioBaseUrl: data?.data?.drawioBaseUrl || '' });
  }, [data, form]);

  const onSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      await api.request({
        url: 'aiDrawio:setConfig',
        method: 'post',
        data: values,
      });
      message.success(t('Saved successfully'));
      refresh();
    } catch (err: any) {
      if (err?.errorFields) return; // form validation
      message.error(err?.message || t('Save failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card loading={loading}>
      <Form form={form} layout="vertical">
        <Form.Item
          label={t('Drawio base URL')}
          name="drawioBaseUrl"
          rules={[{ required: true, type: 'url', message: 'Invalid URL' }]}
          extra={t('Drawio base URL is the self-hosted drawio editor URL (e.g. https://drawio.example.com)')}
        >
          <Input placeholder="https://drawio.example.com" />
        </Form.Item>
        <Form.Item>
          <Button type="primary" onClick={onSave} loading={saving}>
            {t('Save')}
          </Button>
        </Form.Item>
      </Form>
      {data?.data?.fromEnv && (
        <Text type="secondary">Currently sourced from DRAWIO_BASE_URL env var. Saving will override.</Text>
      )}
    </Card>
  );
};

const DiagramsTab: React.FC = () => {
  const t = useT();
  const api = useAPIClient();
  const { message, modal } = AntApp.useApp();
  const [editing, setEditing] = useState<any | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [createForm] = Form.useForm();
  const [creating, setCreating] = useState(false);
  const { data, refresh, loading } = useRequest<any>({
    resource: 'aiDiagrams',
    action: 'list',
    params: { pageSize: 100, sort: ['-updatedAt'] },
  });

  const records = data?.data?.data || data?.data || [];

  const onCreate = async () => {
    try {
      const values = await createForm.validateFields();
      setCreating(true);
      const res = await api.request({
        resource: 'aiDiagrams',
        action: 'create',
        method: 'post',
        data: values,
      });
      message.success(t('Saved successfully'));
      createForm.resetFields();
      setEditing(null);
      refresh();
      const newId = res?.data?.data?.id;
      if (newId) setOpenId(newId);
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(err?.message || t('Save failed'));
    } finally {
      setCreating(false);
    }
  };

  const onUpdate = async () => {
    try {
      const values = await createForm.validateFields();
      setCreating(true);
      await api.request({
        resource: 'aiDiagrams',
        action: 'update',
        method: 'post',
        params: { filterByTk: editing.id },
        data: values,
      });
      message.success(t('Saved successfully'));
      createForm.resetFields();
      setEditing(null);
      refresh();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(err?.message || t('Save failed'));
    } finally {
      setCreating(false);
    }
  };

  const onDelete = (record: any) => {
    modal.confirm({
      title: t('Delete'),
      content: record.title || record.id,
      onOk: async () => {
        await api.request({
          resource: 'aiDiagrams',
          action: 'destroy',
          method: 'post',
          params: { filterByTk: record.id },
        });
        message.success(t('Saved successfully'));
        refresh();
      },
    });
  };

  const columns = useMemo(
    () => [
      { title: t('Title'), dataIndex: 'title', key: 'title' },
      { title: t('Description'), dataIndex: 'description', key: 'description', ellipsis: true },
      { title: t('Updated at'), dataIndex: 'updatedAt', key: 'updatedAt', width: 200 },
      {
        title: t('Actions'),
        key: 'actions',
        width: 260,
        render: (_: any, record: any) => (
          <Space>
            <Button size="small" onClick={() => setOpenId(record.id)}>
              {t('Open in fullscreen')}
            </Button>
            <Button
              size="small"
              onClick={() => {
                setEditing(record);
                createForm.setFieldsValue({ title: record.title, description: record.description });
              }}
            >
              {t('Edit')}
            </Button>
            <Button size="small" danger onClick={() => onDelete(record)}>
              {t('Delete')}
            </Button>
          </Space>
        ),
      },
    ],
    [t, createForm],
  );

  return (
    <Card>
      <Space style={{ marginBottom: 16 }}>
        <Button
          type="primary"
          onClick={() => {
            setEditing({});
            createForm.resetFields();
          }}
        >
          {t('Create diagram')}
        </Button>
      </Space>
      <Table rowKey="id" dataSource={records} columns={columns as any} loading={loading} pagination={{ pageSize: 20 }} />

      <Modal
        title={editing && editing.id ? t('Edit diagram') : t('Create diagram')}
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={editing && editing.id ? onUpdate : onCreate}
        confirmLoading={creating}
      >
        <Form form={createForm} layout="vertical">
          <Form.Item label={t('Title')} name="title" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label={t('Description')} name="description">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        open={!!openId}
        onClose={() => setOpenId(null)}
        width={'100%'}
        title={records.find((r: any) => r.id === openId)?.title || t('Drawio Diagram')}
        destroyOnClose
        styles={{ body: { padding: 0 } }}
      >
        {openId && <DrawioBlock diagramId={openId} height="calc(100vh - 56px)" />}
      </Drawer>
    </Card>
  );
};

const SystemPromptTab: React.FC = () => {
  const t = useT();
  const api = useAPIClient();
  const { message } = AntApp.useApp();
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .request({ url: 'aiDrawio:getSystemPrompt', method: 'get' })
      .then((res) => {
        if (cancelled) return;
        const body = res?.data;
        setPrompt(typeof body === 'string' ? body : String(body ?? ''));
      })
      .catch((err) => {
        if (cancelled) return;
        message.error(err?.message || t('Save failed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, message, t]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      message.success(t('Saved successfully'));
    } catch (err: any) {
      message.error(err?.message || 'Copy failed');
    }
  };

  return (
    <Card loading={loading}>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Text type="secondary">
          {t(
            'Paste this prompt into the "About" / instructions field of the AI Employee that should drive draw.io diagrams. The prompt assumes the four drawio tools and the drawio work-context are enabled for that employee.',
          )}
        </Text>
        <Space>
          <Button onClick={onCopy} type="primary">
            {t('Copy to clipboard')}
          </Button>
        </Space>
        <Input.TextArea
          value={prompt}
          autoSize={{ minRows: 18, maxRows: 40 }}
          readOnly
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
      </Space>
    </Card>
  );
};

export const DrawioManager: React.FC = () => {
  const t = useT();
  const items = [
    { key: 'diagrams', label: t('Diagrams'), children: <DiagramsTab /> },
    { key: 'settings', label: t('Settings'), children: <SettingsTab /> },
    { key: 'systemPrompt', label: t('AI Employee prompt'), children: <SystemPromptTab /> },
  ];
  return <Tabs defaultActiveKey="diagrams" items={items} />;
};
