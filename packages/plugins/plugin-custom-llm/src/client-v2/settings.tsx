import { EnvVariableInput } from '@nocobase/client-v2';
import { ModelSelect } from '@nocobase/plugin-ai/client-v2';
import { Checkbox, Collapse, Form, Input, InputNumber, Select } from 'antd';
import React from 'react';
import { useTranslation } from 'react-i18next';

const namespace = 'plugin-custom-llm';

export function ProviderSettingsForm() {
  const { t } = useTranslation(namespace);
  const streamKeepAlive = Form.useWatch(['options', 'streamKeepAlive']);

  return (
    <>
      <Form.Item name={['options', 'apiKey']} label={t('API Key')} rules={[{ required: true }]}>
        <EnvVariableInput password />
      </Form.Item>
      <Form.Item name={['options', 'disableStream']} valuePropName="checked" extra={t('Disable streaming description')}>
        <Checkbox>{t('Disable streaming')}</Checkbox>
      </Form.Item>
      <Form.Item
        name={['options', 'enableReasoning']}
        valuePropName="checked"
        extra={t('Enable reasoning description')}
      >
        <Checkbox>{t('Enable reasoning')}</Checkbox>
      </Form.Item>
      <Form.Item
        name={['options', 'streamKeepAlive']}
        valuePropName="checked"
        extra={t('Stream keepalive description')}
      >
        <Checkbox>{t('Stream keepalive')}</Checkbox>
      </Form.Item>
      {streamKeepAlive && (
        <Form.Item
          name={['options', 'keepAliveIntervalMs']}
          label={t('Keepalive interval (ms)')}
          extra={t('Keepalive interval description')}
        >
          <InputNumber min={1000} step={1000} placeholder="5000" />
        </Form.Item>
      )}
      <Form.Item name={['options', 'timeout']} label={t('Timeout (ms)')} extra={t('Timeout description')}>
        <InputNumber min={0} step={1000} placeholder="1800000" />
      </Form.Item>
      <Form.Item
        name={['options', 'requestConfig']}
        label={t('Request config (JSON)')}
        extra={t('Request config description')}
      >
        <Input.TextArea
          rows={6}
          placeholder={JSON.stringify({ extraHeaders: {}, extraBody: {}, modelKwargs: {} }, null, 2)}
        />
      </Form.Item>
      <Form.Item
        name={['options', 'responseConfig']}
        label={t('Response config (JSON)')}
        extra={t('Response config description')}
      >
        <Input.TextArea
          rows={8}
          placeholder={JSON.stringify(
            {
              contentPath: 'auto',
              reasoningKey: 'reasoning_content',
              responseMapping: {
                content: 'message.response',
                tool_calls: 'message.tool_calls',
                finish_reason: 'finish_reason',
              },
            },
            null,
            2,
          )}
        />
      </Form.Item>
      <Form.Item
        name={['options', 'modelsConfig']}
        label={t('Models config (JSON)')}
        extra={t('Models config description')}
      >
        <Input.TextArea
          rows={6}
          placeholder={JSON.stringify(
            { path: 'models', auth: 'bearer', headers: {}, dataPath: 'data', idPath: 'id' },
            null,
            2,
          )}
        />
      </Form.Item>
    </>
  );
}

function ModelOptions() {
  const { t } = useTranslation(namespace);
  const responseFormat = Form.useWatch(['options', 'responseFormat']);
  const enableToolRetry = Form.useWatch(['options', 'enableToolRetry']);
  const enableTokenTruncation = Form.useWatch(['options', 'enableTokenTruncation']);

  return (
    <>
      <Form.Item name={['options', 'temperature']} label={t('Temperature')} initialValue={0.7}>
        <InputNumber min={0} max={2} step={0.1} />
      </Form.Item>
      <Form.Item name={['options', 'maxCompletionTokens']} label={t('Max completion tokens')} initialValue={-1}>
        <InputNumber />
      </Form.Item>
      <Form.Item name={['options', 'topP']} label={t('Top P')} initialValue={1}>
        <InputNumber min={0} max={1} step={0.1} />
      </Form.Item>
      <Form.Item name={['options', 'frequencyPenalty']} label={t('Frequency penalty')} initialValue={0}>
        <InputNumber min={-2} max={2} step={0.1} />
      </Form.Item>
      <Form.Item name={['options', 'presencePenalty']} label={t('Presence penalty')} initialValue={0}>
        <InputNumber min={-2} max={2} step={0.1} />
      </Form.Item>
      <Form.Item name={['options', 'responseFormat']} label={t('Response format')} initialValue="text">
        <Select
          options={[
            { label: t('Text'), value: 'text' },
            { label: t('JSON'), value: 'json_object' },
            { label: t('JSON Schema (Strict)'), value: 'json_schema' },
          ]}
        />
      </Form.Item>
      {responseFormat === 'json_schema' && (
        <Form.Item name={['options', 'jsonSchemaDefinition']} label={t('JSON Schema Definition')}>
          <Input.TextArea rows={6} />
        </Form.Item>
      )}
      <Form.Item
        name={['options', 'enableToolRetry']}
        valuePropName="checked"
        initialValue={true}
        extra={t(
          'Retries failed tool calls automatically. Only effective in non-streaming (invoke) mode — has no effect when streaming is enabled.',
        )}
      >
        <Checkbox>{t('Auto Tool-call Retry (invoke only)')}</Checkbox>
      </Form.Item>
      {enableToolRetry && (
        <Form.Item name={['options', 'maxToolRetries']} label={t('Max tool retries')} initialValue={1}>
          <InputNumber min={0} />
        </Form.Item>
      )}
      <Form.Item name={['options', 'enableVision']} valuePropName="checked" initialValue={false}>
        <Checkbox>{t('Enable native Vision')}</Checkbox>
      </Form.Item>
      <Form.Item
        name={['options', 'enableTokenTruncation']}
        valuePropName="checked"
        initialValue={false}
        extra={t(
          'Uses a rough heuristic to estimate token count (not exact). May over- or under-count for some content types. Enable only when hitting context length limits.',
        )}
      >
        <Checkbox>{t('Auto-truncate History')}</Checkbox>
      </Form.Item>
      {enableTokenTruncation && (
        <Form.Item name={['options', 'maxContextTokens']} label={t('Max Context Tokens')} initialValue={8192}>
          <InputNumber min={1} />
        </Form.Item>
      )}
    </>
  );
}

export function ModelSettingsForm() {
  const { t } = useTranslation(namespace);
  return (
    <>
      <Form.Item name="model" label={t('Model')} rules={[{ required: true }]}>
        <ModelSelect />
      </Form.Item>
      <Collapse
        bordered={false}
        size="small"
        items={[{ key: 'options', label: t('Options'), forceRender: true, children: <ModelOptions /> }]}
      />
    </>
  );
}
