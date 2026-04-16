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
import { namespace } from '../../locale';

export const ProviderSettingsForm: React.FC = () => {
  return (
    <SchemaComponent
      schema={{
        type: 'void',
        properties: {
          apiKey: {
            title: tval('API Key', { ns: namespace }),
            type: 'string',
            required: true,
            'x-decorator': 'FormItem',
            'x-component': 'TextAreaWithGlobalScope',
          },
          disableStream: {
            title: tval('Disable streaming', { ns: namespace }),
            type: 'boolean',
            'x-decorator': 'FormItem',
            'x-component': 'Checkbox',
            'x-content': tval('Disable streaming description', { ns: namespace }),
          },
          enableReasoning: {
            title: tval('Enable reasoning', { ns: namespace }),
            type: 'boolean',
            'x-decorator': 'FormItem',
            'x-component': 'Checkbox',
            'x-content': tval('Enable reasoning description', { ns: namespace }),
          },
          streamKeepAlive: {
            title: tval('Stream keepalive', { ns: namespace }),
            type: 'boolean',
            'x-decorator': 'FormItem',
            'x-component': 'Checkbox',
            'x-content': tval('Stream keepalive description', { ns: namespace }),
          },
          keepAliveIntervalMs: {
            title: tval('Keepalive interval (ms)', { ns: namespace }),
            type: 'number',
            'x-decorator': 'FormItem',
            'x-component': 'InputNumber',
            'x-component-props': {
              placeholder: '5000',
              min: 1000,
              step: 1000,
              style: { width: '100%' },
            },
            description: tval('Keepalive interval description', { ns: namespace }),
          },
          keepAliveContent: {
            title: tval('Keepalive content', { ns: namespace }),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': 'Input',
            'x-component-props': {
              placeholder: '...',
            },
            description: tval('Keepalive content description', { ns: namespace }),
          },
          timeout: {
            title: tval('Timeout (ms)', { ns: namespace }),
            type: 'number',
            'x-decorator': 'FormItem',
            'x-component': 'InputNumber',
            'x-component-props': {
              placeholder: '120000',
              min: 0,
              step: 1000,
              style: { width: '100%' },
            },
            description: tval('Timeout description', { ns: namespace }),
          },
          requestConfig: {
            title: tval('Request config (JSON)', { ns: namespace }),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': 'Input.TextArea',
            'x-component-props': {
              placeholder: JSON.stringify(
                {
                  extraHeaders: {},
                  extraBody: {},
                  modelKwargs: {},
                },
                null,
                2,
              ),
              rows: 6,
              style: { fontFamily: 'monospace', fontSize: 12 },
            },
            description: tval('Request config description', { ns: namespace }),
          },
          responseConfig: {
            title: tval('Response config (JSON)', { ns: namespace }),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': 'Input.TextArea',
            'x-component-props': {
              placeholder: JSON.stringify(
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
              ),
              rows: 8,
              style: { fontFamily: 'monospace', fontSize: 12 },
            },
            description: tval('Response config description', { ns: namespace }),
          },
        },
      }}
    />
  );
};
