import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Form,
  Input,
  List,
  message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useApiClient as useAPIClient } from '../../hooks/useApiRequest';
import { useT } from '../locale';
import { formatJsonText, parseJsonText, stringifyJsonText } from '../utils/jsonFields';
import { getLoopTemplate, LOOP_TEMPLATES } from '../tools/loopTemplates';

const { TextArea } = Input;

const extractList = (data: any) => {
  const value = data?.data?.data ?? data?.data ?? data ?? [];
  return Array.isArray(value) ? value : [];
};

export const LoopSettings: React.FC = () => {
  const api = useAPIClient();
  const t = useT();
  const [form] = Form.useForm();
  const [skills, setSkills] = useState<any[]>([]);
  const [configs, setConfigs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [editorVisible, setEditorVisible] = useState(false);
  const [editingConfig, setEditingConfig] = useState<any>(null);

  const skillsById = useMemo(() => new Map(skills.map((skill) => [String(skill.id), skill])), [skills]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [skillsResponse, configsResponse] = await Promise.all([
        api.request({
          url: 'skillDefinitions:list',
          params: {
            filter: { enabled: true },
            fields: ['id', 'name', 'title', 'language', 'autoCall'],
            pageSize: 500,
          },
        }),
        api.request({
          url: 'skillLoopConfigs:list',
          params: {
            fields: ['id', 'skillId', 'enabled', 'title', 'templateKey', 'prompt', 'schema', 'config', 'updatedAt'],
            sort: ['-updatedAt'],
            pageSize: 500,
          },
        }),
      ]);
      setSkills(extractList(skillsResponse.data));
      setConfigs(extractList(configsResponse.data));
    } catch {
      message.error(t('Failed to load skill review settings'));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const openCreate = () => {
    const template = getLoopTemplate('confirm');
    setEditingConfig(null);
    form.resetFields();
    form.setFieldsValue({
      enabled: true,
      templateKey: template.key,
      prompt: template.schema.prompt,
      schema: formatJsonText(template.schema),
      config: '',
    });
    setEditorVisible(true);
  };

  const openEdit = (record: any) => {
    const template = getLoopTemplate(record.templateKey);
    setEditingConfig(record);
    form.setFieldsValue({
      ...record,
      templateKey: record.templateKey || template.key,
      prompt: record.prompt || template.schema.prompt,
      schema: formatJsonText(record.schema || template.schema),
      config: formatJsonText(record.config, null),
    });
    setEditorVisible(true);
  };

  const closeEditor = () => {
    setEditorVisible(false);
    setEditingConfig(null);
    form.resetFields();
  };

  // client-v2 has no aiManager.toolsManager, so loop cards cannot be (re)registered
  // here — the v1 client plugin owns card registration. We only broadcast the
  // change event so any listening v1 surface refreshes.
  const notifyLoopSettingsChanged = useCallback(() => {
    window.dispatchEvent(new Event('skill-hub-loop-settings-changed'));
  }, []);

  const handleTemplateChange = (templateKey: string) => {
    const template = getLoopTemplate(templateKey);
    form.setFieldsValue({
      prompt: template.schema.prompt,
      schema: formatJsonText(template.schema),
    });
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      const schema = parseJsonText<any>(values.schema, undefined);
      if (!schema || typeof schema !== 'object') {
        message.error(t('Invalid JSON in Review Schema'));
        return;
      }

      const config = parseJsonText<any>(values.config, undefined);
      if (values.config && config === undefined) {
        message.error(t('Invalid JSON in Review Config'));
        return;
      }

      const schemaWithPrompt = {
        ...schema,
        prompt: values.prompt || schema.prompt,
      };
      const data = {
        ...values,
        schema: stringifyJsonText(schemaWithPrompt),
        config: values.config ? stringifyJsonText(config) : null,
      };

      if (editingConfig) {
        await api.request({
          url: 'skillLoopConfigs:update',
          method: 'POST',
          params: { filterByTk: editingConfig.id },
          data,
        });
      } else {
        await api.request({
          url: 'skillLoopConfigs:create',
          method: 'POST',
          data,
        });
      }

      message.success(t(editingConfig ? 'Skill review setting updated' : 'Skill review setting created'));
      closeEditor();
      fetchData();
      notifyLoopSettingsChanged();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(t('Failed to save skill review setting'));
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await api.request({ url: 'skillLoopConfigs:destroy', method: 'POST', params: { filterByTk: id } });
      message.success(t('Deleted'));
      fetchData();
      notifyLoopSettingsChanged();
    } catch {
      message.error(t('Failed to delete'));
    }
  };

  const handleToggleEnabled = async (record: any) => {
    try {
      await api.request({
        url: 'skillLoopConfigs:update',
        method: 'POST',
        params: { filterByTk: record.id },
        data: { enabled: !record.enabled },
      });
      fetchData();
      notifyLoopSettingsChanged();
    } catch {
      message.error(t('Failed to update'));
    }
  };

  return (
    <Card
      title={t('Skill Review Settings')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('New Review')}
        </Button>
      }
    >
      <List
        loading={loading}
        dataSource={configs}
        grid={{ gutter: 16, xs: 1, sm: 2, md: 3, lg: 3, xl: 4, xxl: 4 }}
        renderItem={(config) => {
          const skill = skillsById.get(String(config.skillId));
          const template = getLoopTemplate(config.templateKey);
          return (
            <List.Item>
              <Card
                size="small"
                title={
                  <Typography.Text ellipsis>
                    {config.title || skill?.title || skill?.name || t('Unknown skill')}
                  </Typography.Text>
                }
                extra={
                  <Tag color={config.enabled ? 'green' : 'default'}>
                    {config.enabled ? t('Enabled') : t('Disabled')}
                  </Tag>
                }
                actions={[
                  <Tooltip key="edit" title={t('Edit')}>
                    <EditOutlined onClick={() => openEdit(config)} />
                  </Tooltip>,
                  <Popconfirm key="delete" title={t('Delete?')} onConfirm={() => handleDelete(config.id)}>
                    <Tooltip title={t('Delete')}>
                      <DeleteOutlined style={{ color: 'red' }} />
                    </Tooltip>
                  </Popconfirm>,
                ]}
                style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.05)', borderRadius: 8 }}
              >
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                    {skill?.name || `skillId=${config.skillId}`}
                  </Typography.Text>
                  <Tag color="blue" style={{ width: 'fit-content' }}>
                    {template.title}
                  </Tag>
                  <Typography.Paragraph
                    type="secondary"
                    ellipsis={{ rows: 2 }}
                    style={{ minHeight: 44, marginBottom: 0, fontSize: 13 }}
                  >
                    {config.prompt || template.schema.prompt}
                  </Typography.Paragraph>
                  <Space size={4}>
                    <Switch checked={config.enabled} onChange={() => handleToggleEnabled(config)} size="small" />
                    <span style={{ fontSize: 12 }}>{config.enabled ? t('Enabled') : t('Disabled')}</span>
                  </Space>
                </Space>
              </Card>
            </List.Item>
          );
        }}
      />

      <Modal
        open={editorVisible}
        title={editingConfig ? t('Edit Skill Review Setting') : t('New Skill Review Setting')}
        onCancel={closeEditor}
        onOk={handleSave}
        width={760}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="enabled" valuePropName="checked" label={t('Enabled')}>
            <Switch />
          </Form.Item>

          <Form.Item name="skillId" label={t('Skill')} rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder={t('Select a skill')}
              options={skills.map((skill) => ({
                value: skill.id,
                label: `${skill.title || skill.name} (${skill.name})`,
              }))}
            />
          </Form.Item>

          <Form.Item name="title" label={t('Title')}>
            <Input placeholder={t('Optional display title')} />
          </Form.Item>

          <Form.Item name="templateKey" label={t('Review Template')} rules={[{ required: true }]}>
            <Select onChange={handleTemplateChange}>
              {LOOP_TEMPLATES.map((template) => (
                <Select.Option key={template.key} value={template.key}>
                  {template.title} - {template.description}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item name="prompt" label={t('Prompt')} rules={[{ required: true }]}>
            <TextArea rows={3} />
          </Form.Item>

          <Form.Item
            name="schema"
            label={t('Review Schema (JSON)')}
            rules={[{ required: true }]}
            extra={t('Standard interaction schema. Supported types: confirm, form, select.')}
          >
            <TextArea rows={10} style={{ fontFamily: 'monospace', fontSize: 13 }} />
          </Form.Item>

          <Form.Item name="config" label={t('Review Config (optional JSON)')}>
            <TextArea
              rows={4}
              style={{ fontFamily: 'monospace', fontSize: 13 }}
              placeholder={'{\n  "maxRetries": 1\n}'}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
};
