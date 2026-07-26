import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Tabs,
  Card,
  Button,
  Form,
  Input,
  Table,
  Space,
  Modal,
  App as AntApp,
  Typography,
  Drawer,
  Select,
  Tag,
} from 'antd';
import type { TableProps } from 'antd';
import { useRequest } from 'ahooks';
import { useApp } from '@nocobase/client-v2';
import { useT } from './locale';
import { DrawioBlock } from './DrawioBlock';
import { getWrappedData, getWrappedListPayload } from './apiResponse';

const { Text } = Typography;

const diagramModeOptions = [
  { label: 'Editable', value: 'editable' },
  { label: 'Readonly', value: 'readonly' },
];

type UserRecord = {
  id?: string | number;
  nickname?: string;
  name?: string;
  username?: string;
  email?: string;
};

type DrawioConfig = {
  drawioBaseUrl?: string;
  fromEnv?: boolean;
};

type DiagramRecord = {
  id: string;
  title?: string;
  description?: string;
  mode?: string;
  createdById?: string | number;
  createdBy?: UserRecord;
  updatedAt?: string;
};

function getUserDisplayName(user?: UserRecord) {
  return user?.nickname || user?.name || user?.username || user?.email || user?.id || '-';
}

const SettingsTab: React.FC = () => {
  const t = useT();
  const api = useApp().apiClient;
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const { data, refresh, loading } = useRequest(() => api.resource('aiDrawio').getConfig());
  const [saving, setSaving] = useState(false);
  const config = getWrappedData<DrawioConfig>(data);

  useEffect(() => {
    form.setFieldsValue({ drawioBaseUrl: config?.drawioBaseUrl || '' });
  }, [config?.drawioBaseUrl, form]);

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
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'errorFields' in err) return;
      message.error(err instanceof Error ? err.message : t('Save failed'));
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
          rules={[{ required: true, type: 'url', message: t('Invalid URL') }]}
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
      {config?.fromEnv && (
        <Text type="secondary">{t('Currently sourced from DRAWIO_BASE_URL env var. Saving will override.')}</Text>
      )}
    </Card>
  );
};

const DiagramsTab: React.FC = () => {
  const t = useT();
  const api = useApp().apiClient;
  const { message, modal } = AntApp.useApp();
  const [editing, setEditing] = useState<Partial<DiagramRecord> | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [createForm] = Form.useForm();
  const [creating, setCreating] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const { data, refresh, loading } = useRequest(
    () =>
      api.resource('aiDiagrams').list({
        page,
        pageSize,
        sort: ['-updatedAt'],
        fields: ['id', 'title', 'description', 'mode', 'createdById', 'updatedAt'],
        appends: ['createdBy'],
      }),
    { refreshDeps: [page, pageSize] },
  );

  const { rows: records, meta } = getWrappedListPayload<DiagramRecord>(data);

  const onCreate = async () => {
    try {
      const values = await createForm.validateFields();
      setCreating(true);
      const res = await api.resource('aiDiagrams').create({ values });
      message.success(t('Saved successfully'));
      createForm.resetFields();
      setEditing(null);
      refresh();
      const newRecord = getWrappedData<DiagramRecord>(res);
      const newId = newRecord?.id;
      if (newId) setOpenId(newId);
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'errorFields' in err) return;
      message.error(err instanceof Error ? err.message : t('Save failed'));
    } finally {
      setCreating(false);
    }
  };

  const onUpdate = async () => {
    if (!editing?.id) {
      return;
    }
    try {
      const values = await createForm.validateFields();
      setCreating(true);
      await api.resource('aiDiagrams').update({ filterByTk: editing.id, values });
      message.success(t('Saved successfully'));
      createForm.resetFields();
      setEditing(null);
      refresh();
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'errorFields' in err) return;
      message.error(err instanceof Error ? err.message : t('Save failed'));
    } finally {
      setCreating(false);
    }
  };

  const onDelete = useCallback(
    (record: DiagramRecord) => {
      modal.confirm({
        title: t('Delete'),
        content: record.title || record.id,
        onOk: async () => {
          await api.resource('aiDiagrams').destroy({ filterByTk: record.id });
          message.success(t('Saved successfully'));
          refresh();
        },
      });
    },
    [api, message, modal, refresh, t],
  );

  const columns = useMemo<TableProps<DiagramRecord>['columns']>(
    () => [
      { title: t('Title'), dataIndex: 'title', key: 'title' },
      { title: t('Description'), dataIndex: 'description', key: 'description', ellipsis: true },
      {
        title: t('Mode'),
        dataIndex: 'mode',
        key: 'mode',
        width: 120,
        render: (mode: string) => {
          const value = mode || 'editable';
          return (
            <Tag color={value === 'readonly' ? 'orange' : 'green'}>
              {t(value === 'readonly' ? 'Readonly' : 'Editable')}
            </Tag>
          );
        },
      },
      {
        title: t('User'),
        dataIndex: 'createdBy',
        key: 'createdBy',
        width: 180,
        render: (_: unknown, record) => getUserDisplayName(record.createdBy) || record.createdById || '-',
      },
      { title: t('Updated at'), dataIndex: 'updatedAt', key: 'updatedAt', width: 200 },
      {
        title: t('Actions'),
        key: 'actions',
        width: 260,
        render: (_: unknown, record) => (
          <Space>
            <Button size="small" onClick={() => setOpenId(record.id)}>
              {t('Open in fullscreen')}
            </Button>
            <Button
              size="small"
              onClick={() => {
                setEditing(record);
                createForm.setFieldsValue({
                  title: record.title,
                  description: record.description,
                  mode: record.mode || 'editable',
                });
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
    [t, createForm, onDelete],
  );

  return (
    <Card>
      <Space style={{ marginBottom: 16 }}>
        <Button
          type="primary"
          onClick={() => {
            setEditing({});
            createForm.resetFields();
            createForm.setFieldsValue({ mode: 'editable' });
          }}
        >
          {t('Create diagram')}
        </Button>
      </Space>
      <Table
        rowKey="id"
        dataSource={records}
        columns={columns}
        loading={loading}
        pagination={{
          current: meta.page || page,
          pageSize: meta.pageSize || pageSize,
          total: meta.count || records.length,
          showSizeChanger: true,
        }}
        onChange={(pagination) => {
          setPage(pagination.current || 1);
          setPageSize(pagination.pageSize || 20);
        }}
      />

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
          <Form.Item label={t('Mode')} name="mode" initialValue="editable">
            <Select options={diagramModeOptions.map((item) => ({ ...item, label: t(item.label) }))} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        open={!!openId}
        onClose={() => setOpenId(null)}
        width={'100%'}
        title={records.find((record) => record.id === openId)?.title || t('Drawio Diagram')}
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
  const api = useApp().apiClient;
  const { message } = AntApp.useApp();
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const loadPrompt = async () => {
      setLoading(true);
      try {
        const res = await api.request({ url: 'aiDrawio:getSystemPrompt', method: 'get' });
        if (cancelled) return;
        const body = res?.data;
        setPrompt(typeof body === 'string' ? body : String(body ?? ''));
      } catch (err: unknown) {
        if (cancelled) return;
        message.error(err instanceof Error ? err.message : t('Save failed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadPrompt();
    return () => {
      cancelled = true;
    };
  }, [api, message, t]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      message.success(t('Saved successfully'));
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : t('Copy failed'));
    }
  };

  return (
    <Card loading={loading}>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Text type="secondary">
          {t(
            'Paste this prompt into the "About" / instructions field of an AI Employee when you want it to follow the complete Drawio workflow. Drawio tools are available automatically; attaching a drawio work-context is optional.',
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
