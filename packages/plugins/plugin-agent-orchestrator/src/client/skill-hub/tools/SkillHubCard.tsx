import React from 'react';
import { Form, Input, Select, Radio, InputNumber, Button, Space, Card, Typography } from 'antd';
import { ToolsUIProperties } from '@nocobase/client';
import { useInteractionSchemas } from './InteractionSchemasProvider';

export const SkillHubCard: React.FC<ToolsUIProperties> = ({ toolCall, decisions }) => {
  const schemas = useInteractionSchemas();
  const [form] = Form.useForm();

  const sanitize = (name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
  const isGenericExecutor = toolCall.name === 'skill_hub_execute';
  const rawArgs = (toolCall.args as Record<string, any>) || {};
  const skillKey = isGenericExecutor ? sanitize(rawArgs.skillName || '') : toolCall.name.replace(/^skill_hub_/, '');
  const schema = schemas.get(skillKey);

  const interrupted = toolCall.invokeStatus === 'init' || toolCall.invokeStatus === 'interrupted';
  if (!interrupted) {
    return null;
  }

  if (!schema) {
    return (
      <Card size="small" style={{ marginTop: 8 }}>
        <Typography.Paragraph style={{ marginBottom: 12 }}>
          Review this Skill Hub tool call before execution.
        </Typography.Paragraph>
        <Space>
          <Button type="primary" onClick={() => decisions.approve()}>
            Run
          </Button>
          <Button onClick={() => decisions.reject('user_cancel')}>Cancel</Button>
        </Space>
      </Card>
    );
  }

  const onSubmit = async () => {
    const values = await form.validateFields();
    const args = isGenericExecutor
      ? {
          ...rawArgs,
          input: schema.type === 'select' ? values : { ...(rawArgs.input || {}), ...values },
        }
      : schema.type === 'select'
        ? values
        : { ...rawArgs, ...values };
    await decisions.edit(args);
  };

  const renderField = (key: string, f: any) => {
    if (f?.enum) {
      return <Select options={f.enum.map((v: any) => ({ value: v, label: String(v) }))} />;
    }
    if (f?.type === 'number' || f?.type === 'integer') {
      return <InputNumber style={{ width: '100%' }} />;
    }
    return <Input />;
  };

  return (
    <Card size="small" style={{ marginTop: 8 }}>
      <Typography.Paragraph style={{ marginBottom: 12 }}>{schema.prompt}</Typography.Paragraph>

      {schema.type !== 'confirm' && (
        <Form
          form={form}
          layout="vertical"
          initialValues={(isGenericExecutor ? rawArgs.input : rawArgs) || {}}
          style={{ marginBottom: 8 }}
        >
          {schema.type === 'select' && (
            <Form.Item name="choice" rules={[{ required: true }]}>
              <Radio.Group>
                {(schema.options ?? []).map((o) => (
                  <Radio key={String(o.value)} value={o.value}>
                    {o.label}
                  </Radio>
                ))}
              </Radio.Group>
            </Form.Item>
          )}
          {schema.type === 'form' &&
            Object.entries(schema.fields ?? {}).map(([key, f]) => (
              <Form.Item
                key={key}
                name={key}
                label={f.title || key}
                rules={[{ required: !!f.required }]}
              >
                {renderField(key, f)}
              </Form.Item>
            ))}
        </Form>
      )}

      <Space>
        <Button type="primary" onClick={schema.type === 'confirm' ? () => decisions.approve() : onSubmit}>
          Run
        </Button>
        <Button onClick={() => decisions.reject('user_cancel')}>Cancel</Button>
      </Space>
    </Card>
  );
};
