/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { Form, Input, Select, Radio, InputNumber, Button, Space, Card, Typography } from 'antd';
import { ToolsUIProperties } from '@nocobase/client';
import { useInteractionSchemas } from './InteractionSchemasProvider';
import type { InteractionSchema } from './loopTemplates';

export const SkillHubCard: React.FC<ToolsUIProperties> = ({ toolCall, decisions }) => {
  const schemas = useInteractionSchemas();
  const [form] = Form.useForm();

  const isGenericExecutor = toolCall.name === 'skill_hub_execute';
  const rawArgs = (toolCall.args as Record<string, unknown>) || {};
  const input =
    rawArgs.input && typeof rawArgs.input === 'object' && !Array.isArray(rawArgs.input) ? rawArgs.input : {};
  const skillKey = isGenericExecutor
    ? `skill:${typeof rawArgs.skillName === 'string' ? rawArgs.skillName : ''}`
    : `tool:${toolCall.name}`;
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
          input: { ...input, ...values },
        }
      : { ...rawArgs, ...values };
    await decisions.edit(args);
  };

  const renderField = (f: NonNullable<InteractionSchema['fields']>[string]) => {
    if (f?.enum) {
      return <Select options={f.enum.map((v) => ({ value: v, label: String(v) }))} />;
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
          initialValues={isGenericExecutor ? input : rawArgs}
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
              <Form.Item key={key} name={key} label={f.title || key} rules={[{ required: !!f.required }]}>
                {renderField(f)}
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
