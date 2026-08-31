import React, { useState, useEffect } from 'react';
import { useApp } from '@nocobase/client-v2';
import {
  Card,
  Space,
  Button,
  Modal,
  Form,
  Input,
  Select,
  Radio,
  Tag,
  Typography,
  List,
  Progress,
  Spin,
  Alert,
  message,
} from 'antd';
import {
  PlayCircleOutlined,
  DeleteOutlined,
  PlusOutlined,
  LayoutOutlined,
  CheckCircleOutlined,
  SyncOutlined,
  ExclamationCircleOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons';

const { Title, Paragraph, Text } = Typography;

export const BuildUITemplateManager: React.FC<{ embedded?: boolean }> = ({ embedded } = {}) => {
  const api = useApp().apiClient;
  const [spaces, setSpaces] = useState<any[]>([]);
  const [collections, setCollections] = useState<any[]>([]);
  const [services, setServices] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingSpace, setEditingSpace] = useState<any | null>(null);

  const [form] = Form.useForm();
  const selectedService = Form.useWatch('llmService', form);

  // 1. Fetch Spaces
  const fetchSpaces = async () => {
    setLoading(true);
    try {
      const res = await api.resource('aiBuildUiTemplateSpaces').list({
        sort: ['-createdAt'],
      });
      setSpaces(res?.data?.data || []);
    } catch (err) {
      console.error('Failed to load spaces:', err);
      message.error('Failed to load UI generation spaces');
    } finally {
      setLoading(false);
    }
  };

  // 2. Fetch Collections
  const fetchCollections = async () => {
    try {
      const res = await api.resource('collections').list();
      setCollections(res?.data?.data || []);
    } catch (err) {
      console.error('Failed to load collections:', err);
    }
  };

  // 3. Fetch LLM Services
  const fetchServices = async () => {
    try {
      const res = await api.resource('ai').listLLMServices();
      setServices(res?.data?.data || []);
    } catch (err) {
      console.error('Failed to load LLM services:', err);
    }
  };

  // 4. Fetch Models
  useEffect(() => {
    if (!selectedService) {
      setModels([]);
      return;
    }
    api
      .resource('ai')
      .listModels({ llmService: selectedService })
      .then((res) => {
        setModels(res?.data?.data || []);
      })
      .catch((err) => {
        console.error('Failed to load models:', err);
      });
  }, [selectedService, api]);

  useEffect(() => {
    fetchSpaces();
    fetchCollections();
    fetchServices();

    // Auto refresh active builds every 3 seconds
    const interval = setInterval(() => {
      const hasActiveBuild = spaces.some((s) => s.status === 'building');
      if (hasActiveBuild) {
        api
          .resource('aiBuildUiTemplateSpaces')
          .list({ sort: ['-createdAt'] })
          .then((res) => setSpaces(res?.data?.data || []))
          .catch(() => undefined);
      }
    }, 3000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaces]);

  // 5. Open modal for create/edit
  const openModal = (space?: any) => {
    if (space) {
      setEditingSpace(space);
      form.setFieldsValue({
        title: space.title,
        llmService: space.llmService,
        model: space.model,
        systemPrompt: space.systemPrompt,
        promptRequirements: space.promptRequirements,
        type: space.type,
        targetCollection: space.targetCollection,
      });
    } else {
      setEditingSpace(null);
      form.resetFields();
      form.setFieldsValue({
        type: 'block',
      });
    }
    setModalVisible(true);
  };

  // 6. Save Space
  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      if (editingSpace) {
        await api.resource('aiBuildUiTemplateSpaces').update({
          filterByTk: editingSpace.id,
          values,
        });
        message.success('Space updated successfully');
      } else {
        await api.resource('aiBuildUiTemplateSpaces').create({
          values,
        });
        message.success('Space created successfully');
      }
      setModalVisible(false);
      fetchSpaces();
    } catch (err: any) {
      if (err?.name !== 'ValidateError') {
        message.error(err?.message || 'Failed to save space settings');
      }
    }
  };

  // 7. Delete Space
  const handleDelete = async (id: string) => {
    Modal.confirm({
      title: 'Are you sure to delete this generation space?',
      icon: <ExclamationCircleOutlined />,
      okType: 'danger',
      onOk: async () => {
        try {
          await api.resource('aiBuildUiTemplateSpaces').destroy({
            filterByTk: id,
          });
          message.success('Space deleted');
          fetchSpaces();
        } catch (err) {
          message.error('Failed to delete space');
        }
      },
    });
  };

  // 8. Trigger AI build
  const handleBuild = async (id: string) => {
    try {
      message.loading('Triggering AI generation...', 1);
      await api.resource('aiBuildUiTemplateSpaces').build({
        filterByTk: id,
      });
      message.success('UI Template generation task started successfully!');
      fetchSpaces();
    } catch (err: any) {
      message.error(err?.message || 'Failed to trigger build');
    }
  };

  // Render Helpers
  const renderStatusTag = (status: string, phase: string) => {
    if (status === 'completed') {
      return (
        <Tag color="success" icon={<CheckCircleOutlined />}>
          Completed
        </Tag>
      );
    }
    if (status === 'error') {
      return (
        <Tag color="error" icon={<ExclamationCircleOutlined />}>
          Failed
        </Tag>
      );
    }
    if (status === 'building') {
      return (
        <Tag color="processing" icon={<SyncOutlined spin />}>
          Generating ({phase || 'queued'})
        </Tag>
      );
    }
    return <Tag color="default">Draft</Tag>;
  };

  const getPhaseProgress = (phase: string) => {
    switch (phase) {
      case 'queued':
        return 10;
      case 'preparing':
        return 25;
      case 'generating':
        return 60;
      case 'saving':
        return 90;
      case 'completed':
        return 100;
      default:
        return 0;
    }
  };

  return (
    <div style={embedded ? undefined : { padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          {!embedded && <Title level={2}>AI UI Template Builder</Title>}
          {!embedded && <Paragraph type="secondary">
            Generate stunning custom UI Blocks and Popups in seconds using state-of-the-art LLMs, then reuse them in
            NocoBase v2 dynamic forms, dashboards and listings.</Paragraph>}
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>
          New Generation Space
        </Button>
      </div>

      <List
        loading={loading && spaces.length === 0}
        dataSource={spaces}
        renderItem={(space: any) => (
          <Card
            key={space.id}
            style={{ marginBottom: '20px', borderRadius: '12px', boxShadow: '0 4px 12px rgba(0,0,0,0.05)' }}
            actions={[
              <Button
                key="generate"
                type="link"
                icon={<PlayCircleOutlined />}
                onClick={() => handleBuild(space.id)}
                disabled={space.status === 'building'}
              >
                Generate
              </Button>,
              <Button key="edit" type="link" onClick={() => openModal(space)}>
                Edit Settings
              </Button>,
              <Button key="delete" type="link" danger icon={<DeleteOutlined />} onClick={() => handleDelete(space.id)}>
                Delete
              </Button>,
            ]}
          >
            <div
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '16px' }}
            >
              <div>
                <Space align="baseline">
                  <Title level={4} style={{ margin: 0 }}>
                    {space.title}
                  </Title>
                  {renderStatusTag(space.status, space.buildPhase)}
                </Space>
                <div style={{ marginTop: '8px' }}>
                  <Tag color="blue">{space.type === 'popup' ? 'Popup Template' : 'Block Template'}</Tag>
                  {space.targetCollection && <Tag color="purple">Collection: {space.targetCollection}</Tag>}
                  <Tag color="cyan">
                    LLM: {space.llmService} ({space.model})
                  </Tag>
                </div>
              </div>

              {space.templateUid && (
                <Button type="primary" ghost icon={<ArrowRightOutlined />} href="/admin/settings/ui-templates.block">
                  View Template Library
                </Button>
              )}
            </div>

            <Paragraph
              style={{ background: '#f5f5f5', padding: '12px', borderRadius: '8px', borderLeft: '4px solid #1890ff' }}
            >
              <Text strong>User Requirements: </Text>
              {space.promptRequirements || 'No specific requirements typed.'}
            </Paragraph>

            {space.status === 'building' && (
              <div style={{ marginTop: '16px', background: '#fafafa', padding: '16px', borderRadius: '8px' }}>
                <Text type="secondary">Build progress: </Text>
                <Progress percent={getPhaseProgress(space.buildPhase)} status="active" strokeColor="#1890ff" />
                <div style={{ marginTop: '8px', fontFamily: 'monospace', color: '#666' }}>
                  <Spin size="small" style={{ marginRight: '8px' }} />
                  {space.buildLog || 'AI is initiating task...'}
                </div>
              </div>
            )}

            {space.status === 'completed' && space.buildLog && (
              <Alert
                message="Build Complete"
                description={space.buildLog}
                type="success"
                showIcon
                style={{ marginTop: '12px' }}
              />
            )}

            {space.status === 'error' && space.buildLog && (
              <Alert
                message="Generation Failed"
                description={space.buildLog}
                type="error"
                showIcon
                style={{ marginTop: '12px' }}
              />
            )}
          </Card>
        )}
      />

      <Modal
        title={editingSpace ? 'Edit Generation Settings' : 'New UI Generation Space'}
        open={modalVisible}
        onOk={handleSave}
        onCancel={() => setModalVisible(false)}
        width={720}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: '16px' }}>
          <Form.Item
            name="title"
            label={<Text strong>Space Name</Text>}
            rules={[{ required: true, message: 'Please enter a space name' }]}
          >
            <Input placeholder="e.g. Sales KPI Dashboard, Customer Contact Form" />
          </Form.Item>

          <Space size="large" style={{ display: 'flex', width: '100%' }}>
            <Form.Item
              name="llmService"
              label={<Text strong>AI Service</Text>}
              rules={[{ required: true, message: 'Please select an LLM Service' }]}
              style={{ flex: 1, minWidth: '300px' }}
            >
              <Select placeholder="Select Service" onChange={() => form.setFieldValue('model', undefined)}>
                {services.map((s) => (
                  <Select.Option key={s.name} value={s.name}>
                    {s.title || s.name}
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>

            <Form.Item
              name="model"
              label={<Text strong>Model</Text>}
              rules={[{ required: true, message: 'Please select an LLM Model' }]}
              style={{ flex: 1, minWidth: '300px' }}
            >
              <Select placeholder="Select Model" disabled={!selectedService}>
                {models.map((m) => (
                  <Select.Option key={m.id || m.name} value={m.id || m.name}>
                    {m.id || m.name}
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
          </Space>

          <Space size="large" style={{ display: 'flex', width: '100%' }}>
            <Form.Item
              name="type"
              label={<Text strong>Template Type</Text>}
              rules={[{ required: true }]}
              style={{ flex: 1 }}
            >
              <Radio.Group>
                <Radio.Button value="block">Block (V2)</Radio.Button>
                <Radio.Button value="popup">Popup (V2)</Radio.Button>
              </Radio.Group>
            </Form.Item>

            <Form.Item
              name="targetCollection"
              label={<Text strong>Bind Database Collection</Text>}
              style={{ flex: 1, minWidth: '300px' }}
            >
              <Select placeholder="Select target collection (optional)" allowClear showSearch>
                {collections.map((c) => (
                  <Select.Option key={c.name} value={c.name}>
                    {c.title || c.name}
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
          </Space>

          <Form.Item
            name="promptRequirements"
            label={<Text strong>UI Requirements & Features Description</Text>}
            rules={[{ required: true, message: 'Please describe the layout you need AI to generate' }]}
          >
            <Input.TextArea
              rows={4}
              placeholder="e.g. Build a comprehensive customer feedback form featuring inputs for name, email, rating slider, multi-line comment text area, and an agreement checkbox. Place them in a nice 2-column grid."
            />
          </Form.Item>

          <Form.Item name="systemPrompt" label={<Text strong>Advanced System Prompt Override (Optional)</Text>}>
            <Input.TextArea
              rows={3}
              placeholder="Override the default system prompt to customize how the LLM structures the component trees."
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};
