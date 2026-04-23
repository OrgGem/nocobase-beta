/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { SchemaComponent } from '@nocobase/client';
import { tval } from '@nocobase/utils/client';
import { namespace, useT } from '../../locale';
import { Collapse } from 'antd';
import { ModelSelect } from '@nocobase/plugin-ai/client';

const Options: React.FC = () => {
  const t = useT();
  return (
    <div style={{ marginBottom: 24 }}>
      <Collapse
        bordered={false}
        size="small"
        items={[
          {
            key: 'options',
            label: t('Options'),
            forceRender: true,
            children: (
              <SchemaComponent
                schema={{
                  type: 'void',
                  name: 'custom-llm',
                  properties: {
                    temperature: {
                      title: tval('Temperature', { ns: namespace }),
                      type: 'number',
                      'x-decorator': 'FormItem',
                      'x-component': 'InputNumber',
                      default: 0.7,
                      'x-component-props': {
                        step: 0.1,
                        min: 0.0,
                        max: 2.0,
                      },
                    },
                    maxCompletionTokens: {
                      title: tval('Max completion tokens', { ns: namespace }),
                      type: 'number',
                      'x-decorator': 'FormItem',
                      'x-component': 'InputNumber',
                      default: -1,
                    },
                    topP: {
                      title: tval('Top P', { ns: namespace }),
                      type: 'number',
                      'x-decorator': 'FormItem',
                      'x-component': 'InputNumber',
                      default: 1.0,
                      'x-component-props': {
                        step: 0.1,
                        min: 0.0,
                        max: 1.0,
                      },
                    },
                    frequencyPenalty: {
                      title: tval('Frequency penalty', { ns: namespace }),
                      type: 'number',
                      'x-decorator': 'FormItem',
                      'x-component': 'InputNumber',
                      default: 0.0,
                      'x-component-props': {
                        step: 0.1,
                        min: -2.0,
                        max: 2.0,
                      },
                    },
                    presencePenalty: {
                      title: tval('Presence penalty', { ns: namespace }),
                      type: 'number',
                      'x-decorator': 'FormItem',
                      'x-component': 'InputNumber',
                      default: 0.0,
                      'x-component-props': {
                        step: 0.1,
                        min: -2.0,
                        max: 2.0,
                      },
                    },
                    responseFormat: {
                      title: tval('Response format', { ns: namespace }),
                      type: 'string',
                      'x-decorator': 'FormItem',
                      'x-component': 'Select',
                      enum: [
                        { label: t('Text'), value: 'text' },
                        { label: t('JSON'), value: 'json_object' },
                        { label: t('JSON Schema (Strict)'), value: 'json_schema' },
                      ],
                      default: 'text',
                    },
                    jsonSchemaDefinition: {
                      title: tval('JSON Schema Definition', { ns: namespace }),
                      type: 'string',
                      'x-decorator': 'FormItem',
                      'x-component': 'Input.TextArea',
                      'x-component-props': {
                        placeholder: '{\n  "type": "object",\n  "properties": {}\n}',
                        rows: 6,
                        style: { fontFamily: 'monospace', fontSize: 12 },
                      },
                      'x-reactions': {
                        dependencies: ['.responseFormat'],
                        fulfill: { state: { visible: '{{$deps[0] === "json_schema"}}' } },
                      },
                    },

                    enableToolRetry: {
                      title: tval('Auto Tool-call Retry', { ns: namespace }),
                      type: 'boolean',
                      'x-decorator': 'FormItem',
                      'x-component': 'Checkbox',
                      default: true,
                    },
                    maxToolRetries: {
                      title: tval('Max tool retries', { ns: namespace }),
                      type: 'number',
                      'x-decorator': 'FormItem',
                      'x-component': 'InputNumber',
                      default: 1,
                      'x-reactions': {
                        dependencies: ['.enableToolRetry'],
                        fulfill: { state: { visible: '{{$deps[0]}}' } },
                      },
                    },
                    enableVision: {
                      title: tval('Enable native Vision', { ns: namespace }),
                      type: 'boolean',
                      'x-decorator': 'FormItem',
                      'x-component': 'Checkbox',
                      default: false,
                    },
                    enableTokenTruncation: {
                      title: tval('Auto-truncate History', { ns: namespace }),
                      type: 'boolean',
                      'x-decorator': 'FormItem',
                      'x-component': 'Checkbox',
                      default: false,
                    },
                    maxContextTokens: {
                      title: tval('Max Context Tokens', { ns: namespace }),
                      type: 'number',
                      'x-decorator': 'FormItem',
                      'x-component': 'InputNumber',
                      default: 8192,
                      'x-reactions': {
                        dependencies: ['.enableTokenTruncation'],
                        fulfill: { state: { visible: '{{$deps[0]}}' } },
                      },
                    },
                  },
                }}
              />
            ),
          },
        ]}
      />
    </div>
  );
};

export const ModelSettingsForm: React.FC = () => {
  return (
    <SchemaComponent
      components={{ Options, ModelSelect }}
      schema={{
        type: 'void',
        properties: {
          model: {
            title: tval('Model', { ns: namespace }),
            type: 'string',
            required: true,
            'x-decorator': 'FormItem',
            'x-component': 'ModelSelect',
          },
          options: {
            type: 'void',
            'x-component': 'Options',
          },
        },
      }}
    />
  );
};
