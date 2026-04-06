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
                      ],
                      default: 'text',
                    },
                    timeout: {
                      title: tval('Timeout (ms)', { ns: namespace }),
                      type: 'number',
                      'x-decorator': 'FormItem',
                      'x-component': 'InputNumber',
                      default: 60000,
                    },
                    maxRetries: {
                      title: tval('Max retries', { ns: namespace }),
                      type: 'number',
                      'x-decorator': 'FormItem',
                      'x-component': 'InputNumber',
                      default: 1,
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
