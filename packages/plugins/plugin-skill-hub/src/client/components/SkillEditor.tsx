import React, { useEffect } from 'react';
import { Modal, Form, Input, Select, InputNumber, Switch, message } from 'antd';
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
        <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
          <Input placeholder="generate-word-report" disabled={isEditing} />
        </Form.Item>

        <Form.Item name="title" label={t('Title')} rules={[{ required: true }]}>
          <Input placeholder="Generate Word Report" />
        </Form.Item>

        <Form.Item name="description" label={t('Description')}>
          <TextArea rows={2} placeholder="Description for AI employee to understand this skill" />
        </Form.Item>

        <Form.Item name="language" label={t('Language')} rules={[{ required: true }]}>
          <Select>
            <Select.Option value="python">Python</Select.Option>
            <Select.Option value="node">Node.js</Select.Option>
          </Select>
        </Form.Item>

        <Form.Item
          name="codeTemplate"
          label={t('Code Template')}
          rules={[{ required: true }]}
          extra={t('Use {{placeholder}} for input parameters. Use OUTPUT_DIR env var for output directory.')}
        >
          <TextArea
            rows={12}
            style={{ fontFamily: 'monospace', fontSize: 13 }}
            placeholder={'import os\n\noutput_dir = os.environ.get("OUTPUT_DIR", "/output")\n# Your code here'}
          />
        </Form.Item>

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

        <Form.Item name="packages" label={t('Packages (JSON array)')}>
          <Input placeholder='["python-docx", "openpyxl"]' style={{ fontFamily: 'monospace' }} />
        </Form.Item>

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
