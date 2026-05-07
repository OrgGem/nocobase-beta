import React, { useEffect, useState } from 'react';
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Select,
  Switch,
  Space,
  Popconfirm,
  message,
  Typography,
  Tag,
  Card,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, ApiOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useT } from './locale';

const { TextArea } = Input;
const { Text, Title } = Typography;

interface ProxyService {
  id: number;
  slug: string;
  title: string;
  targetUrl: string;
  stripPrefix: boolean;
  forwardAuth: boolean;
  rewriteHtml: boolean;
  renderMode: string;
  enabled: boolean;
  description?: string;
}

export const ProxyServiceManager: React.FC = () => {
  const api = useAPIClient();
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [services, setServices] = useState<ProxyService[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ProxyService | null>(null);
  const [form] = Form.useForm();

  const fetchServices = async () => {
    setLoading(true);
    try {
      const res = await api.request({ url: 'proxyServices:list', params: { pageSize: 200, sort: ['-createdAt'] } });
      setServices(res?.data?.data || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchServices();
  }, []);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ stripPrefix: true, forwardAuth: false, rewriteHtml: true, renderMode: 'iframe', enabled: true });
    setModalOpen(true);
  };

  const openEdit = (svc: ProxyService) => {
    setEditing(svc);
    form.setFieldsValue(svc);
    setModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    try {
      await api.request({ url: `proxyServices:destroy`, params: { filterByTk: id } });
      message.success(t('Deleted'));
      fetchServices();
    } catch {
      message.error(t('Delete failed'));
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (editing) {
        await api.request({
          url: 'proxyServices:update',
          params: { filterByTk: editing.id },
          method: 'post',
          data: values,
        });
        message.success(t('Updated'));
      } else {
        await api.request({ url: 'proxyServices:create', method: 'post', data: values });
        message.success(t('Created'));
      }
      setModalOpen(false);
      fetchServices();
    } catch (err: any) {
      if (err?.errorFields) return; // form validation
      message.error(err?.response?.data?.errors?.[0]?.message || t('Save failed'));
    }
  };

  const columns = [
    {
      title: t('Slug'),
      dataIndex: 'slug',
      key: 'slug',
      render: (slug: string) => (
        <Tag color="blue" style={{ fontFamily: 'monospace' }}>
          /proxy/{slug}/
        </Tag>
      ),
    },
    { title: t('Title'), dataIndex: 'title', key: 'title' },
    {
      title: t('Target URL'),
      dataIndex: 'targetUrl',
      key: 'targetUrl',
      render: (url: string) => (
        <Text code copyable style={{ fontSize: 12 }}>
          {url}
        </Text>
      ),
    },
    {
      title: t('Strip Prefix'),
      dataIndex: 'stripPrefix',
      key: 'stripPrefix',
      render: (v: boolean) => (v ? <Tag color="green">Yes</Tag> : <Tag>No</Tag>),
    },
    {
      title: t('Render Mode'),
      dataIndex: 'renderMode',
      key: 'renderMode',
      render: (v: string) => {
        if (v === 'embed') return <Tag color="purple">{t('Embed')}</Tag>;
        return <Tag color="blue">{t('iframe')}</Tag>;
      },
    },
    {
      title: t('SPA Rewrite'),
      dataIndex: 'rewriteHtml',
      key: 'rewriteHtml',
      render: (v: boolean) => (v ? <Tag color="cyan">{t('Active')}</Tag> : <Tag>{t('Disabled')}</Tag>),
    },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      key: 'enabled',
      render: (v: boolean) => (v ? <Tag color="success">{t('Active')}</Tag> : <Tag>{t('Disabled')}</Tag>),
    },
    {
      title: t('Actions'),
      key: 'actions',
      render: (_: any, record: ProxyService) => (
        <Space>
          <Button type="link" icon={<EditOutlined />} onClick={() => openEdit(record)} />
          <Popconfirm title={t('Delete this service?')} onConfirm={() => handleDelete(record.id)}>
            <Button type="link" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>
          <ApiOutlined /> {t('Proxy Services')}
        </Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('Add Service')}
        </Button>
      </div>

      <Table
        dataSource={services}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={false}
        size="middle"
      />

      <Modal
        title={editing ? t('Edit Proxy Service') : t('Add Proxy Service')}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        destroyOnClose
        width={560}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="slug"
            label={t('Slug')}
            rules={[
              { required: true, message: t('Required') },
              { pattern: /^[a-z0-9][a-z0-9_-]*$/, message: t('Lowercase letters, numbers, dashes and underscores') },
            ]}
            extra={t('URL path segment: /proxy/<slug>/')}
          >
            <Input placeholder="testA" />
          </Form.Item>

          <Form.Item name="title" label={t('Title')} rules={[{ required: true, message: t('Required') }]}>
            <Input placeholder="Test Service A" />
          </Form.Item>

          <Form.Item
            name="targetUrl"
            label={t('Target URL')}
            rules={[
              { required: true, message: t('Required') },
              { type: 'url', message: t('Must be a valid URL') },
            ]}
            extra={t('Full base URL of the target service, e.g. http://testA:3000')}
          >
            <Input placeholder="http://testA:3000" />
          </Form.Item>

          <Form.Item
            name="stripPrefix"
            label={t('Strip Prefix')}
            valuePropName="checked"
            extra={t('When enabled, /proxy/slug/api/data → target:port/api/data. When disabled, the full path is forwarded.')}
          >
            <Switch />
          </Form.Item>

          <Form.Item
            name="forwardAuth"
            label={t('Forward Auth Headers')}
            valuePropName="checked"
            extra={t('Forward Authorization and Cookie headers to the target')}
          >
            <Switch />
          </Form.Item>

          <Form.Item
            name="rewriteHtml"
            label={t('SPA / HTML Rewrite')}
            valuePropName="checked"
            extra={t('Rewrite absolute paths in HTML for SPA support. Patches static files, API calls, and client-side routing to work through the proxy.')}
          >
            <Switch />
          </Form.Item>

          <Form.Item
            name="renderMode"
            label={t('Default Render Mode')}
            extra={t('iframe: full SPA support with isolation. Embed: Shadow DOM for static/server-rendered pages (Grafana, docs, reports).')}
          >
            <Select
              options={[
                { label: t('iframe — Full SPA'), value: 'iframe' },
                { label: t('Embed — Shadow DOM'), value: 'embed' },
              ]}
            />
          </Form.Item>

          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>

          <Form.Item name="description" label={t('Description')}>
            <TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
};
