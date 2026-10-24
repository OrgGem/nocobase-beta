import type { ToolsUIProperties } from '@nocobase/client-v2';
import { useRequest } from 'ahooks';
import { App, Button, Card, Checkbox, Form, Input, InputNumber, Radio, Select, Space, Typography } from 'antd';
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useInteractions } from './InteractionSchemasProvider';
import { asRecord, editedSkillArgs, getToolInteraction } from './interactions';

export function SkillHubCard({ toolCall, decisions }: ToolsUIProperties) {
  const { t } = useTranslation(['plugin-agent-orchestrator', 'client']);
  const { message } = App.useApp();
  const interactions = useInteractions();
  const schema = getToolInteraction(interactions, toolCall.name, toolCall.args);
  const [form] = Form.useForm<Record<string, unknown>>();
  const busy = useRef(false);
  const generic = toolCall.name === 'skill_hub_execute';
  const needsApproval = ['init', 'interrupted', 'waiting'].includes(toolCall.invokeStatus);

  useEffect(() => {
    if (!needsApproval) return;
    form.resetFields();
    const args = asRecord(toolCall.args);
    form.setFieldsValue(generic ? asRecord(args.input) : args);
  }, [form, toolCall.id, toolCall.args, schema, generic, needsApproval]);

  const submit = useRequest(
    async (reject = false) => {
      if (busy.current) return;
      busy.current = true;
      try {
        if (reject) await decisions.reject('user_cancel');
        else if (!schema || schema.type === 'confirm') await decisions.approve();
        else {
          let values: Record<string, unknown>;
          try {
            values = await form.validateFields();
          } catch {
            return;
          }
          await decisions.edit(editedSkillArgs(toolCall.name, toolCall.args, schema, values));
        }
      } finally {
        busy.current = false;
      }
    },
    { manual: true, onError: () => message.error(t('Failed to submit skill decision')) },
  );

  if (!needsApproval) return null;
  return (
    <Card size="small" style={{ marginTop: 8 }}>
      <Typography.Paragraph>
        {schema?.prompt || t('Review this Skill Hub tool call before execution.')}
      </Typography.Paragraph>
      <Form form={form} layout="vertical" disabled={submit.loading} style={{ marginBottom: 8 }}>
        {schema?.type === 'select' && (
          <Form.Item name="choice" label={t('Choice')} rules={[{ required: true }]}>
            <Radio.Group>
              {schema.options?.map((option) => (
                <Radio key={String(option.value)} value={option.value}>
                  {option.label}
                </Radio>
              ))}
            </Radio.Group>
          </Form.Item>
        )}
        {schema?.type === 'form' &&
          Object.entries(schema.fields || {}).map(([key, field]) => (
            <Form.Item
              key={key}
              name={key}
              label={field.title || key}
              valuePropName={field.type === 'boolean' && !field.enum ? 'checked' : 'value'}
              rules={[{ required: field.required }]}
            >
              {field.enum?.some((value) => typeof value === 'boolean') ? (
                <Radio.Group options={field.enum.map((value) => ({ value, label: String(value) }))} />
              ) : field.enum ? (
                <Select
                  options={field.enum
                    .filter((value): value is string | number => typeof value !== 'boolean')
                    .map((value) => ({ value, label: String(value) }))}
                />
              ) : field.type === 'number' || field.type === 'integer' ? (
                <InputNumber precision={field.type === 'integer' ? 0 : undefined} style={{ width: '100%' }} />
              ) : field.type === 'boolean' ? (
                <Checkbox />
              ) : (
                <Input />
              )}
            </Form.Item>
          ))}
      </Form>
      <Space>
        <Button type="primary" loading={submit.loading} onClick={() => submit.run(false)}>
          {t('Run')}
        </Button>
        <Button disabled={submit.loading} onClick={() => submit.run(true)}>
          {t('Cancel')}
        </Button>
      </Space>
    </Card>
  );
}
