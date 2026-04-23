import React, { useEffect, useState } from 'react';
import { Modal, Form, Input, Select, InputNumber, Switch, message, Upload, Radio } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useT } from '../locale';

const { TextArea } = Input;

interface SkillEditorProps {
  skill: any | null;
  onClose: (saved?: boolean) => void;
}

export const SkillEditor: React.FC<SkillEditorProps> = ({ skill, onClose }) => {
  const api = useAPIClient();
  const t = useT();
  const [form] = Form.useForm();
  const isEditing = !!skill;
  const [templates, setTemplates] = useState<any[]>([]);

  useEffect(() => {
    if (!isEditing) {
      api.request({ url: 'skillHub:listTemplates' }).then(({ data }) => {
        let t = data?.data || data;
        if (t && t.data && Array.isArray(t.data)) t = t.data;
        setTemplates(Array.isArray(t) ? t : []);
      }).catch(() => {
        setTemplates([]);
      });
    }
  }, [api, isEditing]);



  useEffect(() => {
    if (skill) {
      form.setFieldsValue({
        ...skill,
        inputSchema: skill.inputSchema ? JSON.stringify(skill.inputSchema, null, 2) : '',
        packages: skill.packages ? JSON.stringify(skill.packages) : '[]',
      });
    } else {
      form.resetFields();
      form.setFieldsValue({
        storageType: 'database',
        language: 'python',
        timeoutSeconds: 60,
        maxOutputSizeMb: 50,
        enabled: true,
        toolScope: 'CUSTOM',
        autoCall: false,
        packages: '[]',
      });
    }
  }, [skill, form]);

  const storageType = Form.useWatch('storageType', form) || 'database';

  // Overwrite local UI for plugin binding
  useEffect(() => {
    if (storageType === 'plugin') {
      const pSource = form.getFieldValue('pluginSource');
      if (pSource) {
        const tmpl = templates.find(t => t.name === pSource);
        if (tmpl) {
          form.setFieldsValue({
            name: tmpl.name,
            title: tmpl.title,
            description: tmpl.description,
            language: tmpl.language,
          });
        }
      }
    }
  }, [storageType, templates, form]);

  const handleTemplateSelect = (templateName: string) => {
    const tmpl = templates.find(t => t.name === templateName);
    if (!tmpl) return;
    
    if (storageType === 'plugin') {
      form.setFieldsValue({
        name: tmpl.name,
        title: tmpl.title,
        description: tmpl.description || '',
        language: tmpl.language || 'python',
      });
    } else {
      form.setFieldsValue({
        name: tmpl.name,
        title: tmpl.title,
        description: tmpl.description || '',
        language: tmpl.language || 'python',
        codeTemplate: tmpl.codeTemplate || '',
        inputSchema: tmpl.inputSchema ? JSON.stringify(tmpl.inputSchema, null, 2) : '',
        packages: tmpl.packages ? JSON.stringify(tmpl.packages) : '[]',
        timeoutSeconds: tmpl.timeoutSeconds || 60,
        maxOutputSizeMb: tmpl.maxOutputSizeMb || 50,
        toolScope: tmpl.toolScope || 'CUSTOM',
        enabled: tmpl.enabled ?? true,
      });
    }
    message.success(t('Template applied'));
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();

      // Parse JSON fields
      let inputSchema;
      try {
        inputSchema = values.inputSchema ? JSON.parse(values.inputSchema) : null;
      } catch {
        message.error(t('Invalid JSON in Input Schema'));
        return;
      }

      let packages;
      try {
        packages = values.packages ? JSON.parse(values.packages) : [];
      } catch {
        packages = [];
      }

      const data = {
        ...values,
        inputSchema,
        packages,
      };

      if (isEditing) {
        await api.request({
          url: 'skillDefinitions:update',
          method: 'POST',
          params: { filterByTk: skill.id },
          data,
        });
      } else {
        await api.request({
          url: 'skillDefinitions:create',
          method: 'POST',
          data,
        });
      }

      message.success(t(isEditing ? 'Skill updated' : 'Skill created'));
      onClose(true);
    } catch (err: any) {
      if (err?.errorFields) return; // Form validation error
      message.error(t('Failed to save skill'));
    }
  };

  return (
    <Modal
      open
      title={isEditing ? t('Edit Skill') : t('New Skill')}
      onCancel={() => onClose()}
      onOk={handleSave}
      width={720}
      destroyOnClose
    >
      <Form form={form} layout="vertical" size="middle">
        <Form.Item name="storageType" label={t('Skill Data Source')} style={{ marginBottom: 24, padding: 12, background: '#f8f9fa', borderRadius: 8, border: '1px solid #eee' }}>
          <Radio.Group optionType="button" buttonStyle="solid">
            <Radio value="database">{t('Database Editor')}</Radio>
            <Radio value="local">{t('ZIP Package')}</Radio>
            <Radio value="plugin" disabled={!Array.isArray(templates) || templates.length === 0}>{t('Bind to Plugin')}</Radio>
          </Radio.Group>
        </Form.Item>

        {storageType === 'database' && !isEditing && Array.isArray(templates) && templates.length > 0 && (
          <Form.Item label={t('Import Template to Pre-fill code (Optional)')} style={{ marginBottom: 24 }}>
            <Select 
              placeholder={t('Select a template to pre-fill')} 
              onChange={handleTemplateSelect}
              allowClear
            >
              {templates.map(tmpl => (
                <Select.Option key={tmpl.name} value={tmpl.name}>
                  {tmpl.title} ({tmpl.pluginSource || tmpl.name})
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
        )}

        {storageType === 'plugin' && (
          <Form.Item 
            name="pluginSource" 
            label={t('Select Plugin Skill')} 
            rules={[{ required: true }]} 
            style={{ marginBottom: 24, padding: 12, background: '#e6f4ff', borderRadius: 8, border: '1px solid #91caff' }}
            extra={<div style={{ fontSize: 12, color: '#1677ff', marginTop: 8 }}>{t('Binding dynamically delegates execution to the plugin logic. Code, Language, and Schemas are managed externally.')}</div>}
          >
            <Select 
              placeholder={t('Choose an enabled plugin skill to attach')} 
              onChange={handleTemplateSelect}
              allowClear
            >
              {Array.isArray(templates) && templates.map(tmpl => (
                <Select.Option key={tmpl.name} value={tmpl.name}>
                  {tmpl.title} ({tmpl.pluginSource || tmpl.name})
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
        )}

        <Form.Item name="name" label={t('Name (Internal Identifier)')} rules={[{ required: true }]}>
          <Input placeholder="generate-word-report" disabled={isEditing || storageType === 'plugin'} />
        </Form.Item>

        <Form.Item name="title" label={t('Title')} rules={[{ required: true }]}>
          <Input placeholder="Generate Word Report" disabled={storageType === 'plugin'} />
        </Form.Item>

        <Form.Item name="description" label={t('Description')}>
          <TextArea rows={2} placeholder="Description for AI employee to understand this skill" disabled={storageType === 'plugin'} />
        </Form.Item>

        {storageType === 'local' && (
          <Form.Item label={t('Skill Package ZIP')} name="fileId" valuePropName="fileId" getValueFromEvent={(e: any) => e?.file?.response?.data?.id || e?.fileList?.[0]?.response?.data?.id || undefined} rules={[{ required: true }]}>
            <Upload.Dragger
              name="file"
              action="/api/attachments:create"
              headers={{ Authorization: `Bearer ${api.auth.getToken()}` }}
              maxCount={1}
              accept=".zip"
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">{t('Click or drag ZIP file to this area to upload')}</p>
              <p className="ant-upload-hint">
                {t('Upload a skill package zip containing SKILL.md and index.py/.js. Metadata will be extracted automatically.')}
              </p>
            </Upload.Dragger>
          </Form.Item>
        )}

        {storageType !== 'plugin' && (
          <Form.Item name="language" label={t('Language')}>
            <Select>
              <Select.Option value="python">Python</Select.Option>
              <Select.Option value="node">Node.js</Select.Option>
            </Select>
          </Form.Item>
        )}

        {storageType === 'database' && (
          <Form.Item
            name="codeTemplate"
            label={t('Code Template')}
            extra={t('Use {{placeholder}} for input parameters. Use OUTPUT_DIR env var for output directory.')}
            rules={[{ required: true }]}
          >
            <TextArea
              rows={12}
              style={{ fontFamily: 'monospace', fontSize: 13 }}
              placeholder={'import os\n\noutput_dir = os.environ.get("OUTPUT_DIR", "/output")\n# Your code here'}
            />
          </Form.Item>
        )}

        {storageType !== 'plugin' && (
          <Form.Item
            name="inputSchema"
            label={t('Input Schema (JSON)')}
            extra={t('JSON Schema defining input parameters for this skill')}
          >
            <TextArea
              rows={6}
              style={{ fontFamily: 'monospace', fontSize: 13 }}
              placeholder={'{\n  "type": "object",\n  "properties": {},\n  "required": []\n}'}
            />
          </Form.Item>
        )}

        {storageType !== 'plugin' && (
          <Form.Item name="packages" label={t('Packages (JSON array)')}>
            <Input placeholder='["python-docx", "openpyxl"]' style={{ fontFamily: 'monospace' }} />
          </Form.Item>
        )}

        <div style={{ display: 'flex', gap: 16 }}>
          <Form.Item name="timeoutSeconds" label={t('Timeout (seconds)')} style={{ flex: 1 }}>
            <InputNumber min={5} max={300} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item name="maxOutputSizeMb" label={t('Max Output (MB)')} style={{ flex: 1 }}>
            <InputNumber min={1} max={200} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item name="toolScope" label={t('Tool Scope')} style={{ flex: 1 }}>
            <Select>
              <Select.Option value="CUSTOM">CUSTOM</Select.Option>
              <Select.Option value="GENERAL">GENERAL</Select.Option>
              <Select.Option value="SPECIFIED">SPECIFIED</Select.Option>
            </Select>
          </Form.Item>
        </div>

        <div style={{ display: 'flex', gap: 24 }}>
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>

          <Form.Item name="autoCall" label={t('Auto Call')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
};
