/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { FormTab } from '@formily/antd-v5';
import { useForm } from '@formily/react';
import { SchemaComponent } from '@nocobase/client';
import React, { useEffect } from 'react';
import { DEFAULT_PORT, DEFAULT_SCHEMA, NAMESPACE } from '../constants';

const nsT = (key: string) => `{{t(${JSON.stringify(key)}, { ns: "${NAMESPACE}" })}}`;

interface ConfigurationFormProps {
  from?: 'create' | 'edit';
}

export const ConfigurationForm: React.FC<ConfigurationFormProps> = ({ from }) => {
  const form = useForm();

  useEffect(() => {
    const options = (form?.values?.options || {}) as Record<string, unknown>;
    const loadAll =
      typeof options.addAllCollections === 'boolean' ? options.addAllCollections : options.autoDiscover !== false;
    if (options.addAllCollections !== loadAll) {
      form.setValuesIn('options.addAllCollections', loadAll);
    }
    if (options.autoDiscover !== loadAll) {
      form.setValuesIn('options.autoDiscover', loadAll);
    }
    if (from !== 'create') {
      if (Array.isArray(options.selectedCollections) && !Array.isArray(form.values.collections)) {
        form.setValuesIn(
          'collections',
          options.selectedCollections
            .filter((name): name is string => typeof name === 'string' && name.length > 0)
            .map((name) => ({ name, selected: true })),
        );
      }
      if (from === 'edit' || !loadAll) {
        form.setValuesIn('__postgresPreserveSelection', true);
      }
    }
  }, [form, from]);

  const schema = {
    type: 'object',
    properties: {
      displayName: {
        type: 'string',
        title: nsT('Display Name'),
        'x-decorator': 'FormItem',
        'x-component': 'Input',
        'x-decorator-props': {
          tooltip: nsT('The connection name to display in NocoBase'),
        },
        required: true,
      },
      options: {
        type: 'object',
        properties: {
          tabs: {
            type: 'void',
            'x-component': 'FormTab',
            'x-component-props': {},
            properties: {
              connection: {
                type: 'void',
                'x-component': 'FormTab.TabPane',
                'x-component-props': {
                  tab: nsT('Connection Settings'),
                },
                properties: {
                  host: {
                    type: 'string',
                    title: nsT('Host'),
                    'x-decorator': 'FormItem',
                    'x-component': 'Input',
                    'x-decorator-props': {
                      tooltip: nsT('PostgreSQL server hostname or IP address'),
                    },
                    default: 'localhost',
                    required: true,
                  },
                  port: {
                    type: 'number',
                    title: nsT('Port'),
                    'x-decorator': 'FormItem',
                    'x-component': 'InputNumber',
                    'x-decorator-props': {
                      tooltip: nsT('PostgreSQL server port number'),
                    },
                    'x-component-props': {
                      min: 1,
                      max: 65535,
                      style: { width: '100%' },
                    },
                    default: DEFAULT_PORT,
                    required: true,
                  },
                  database: {
                    type: 'string',
                    title: nsT('Database'),
                    'x-decorator': 'FormItem',
                    'x-component': 'Input',
                    'x-decorator-props': {
                      tooltip: nsT('Name of the PostgreSQL database'),
                    },
                    required: true,
                  },
                  username: {
                    type: 'string',
                    title: nsT('Username'),
                    'x-decorator': 'FormItem',
                    'x-component': 'Input',
                    'x-decorator-props': {
                      tooltip: nsT('Database username for authentication'),
                    },
                    required: true,
                  },
                  password: {
                    type: 'string',
                    title: nsT('Password'),
                    'x-decorator': 'FormItem',
                    'x-component': 'Password',
                    'x-decorator-props': {
                      tooltip: nsT('Database password for authentication'),
                    },
                  },
                },
              },
              advanced: {
                type: 'void',
                'x-component': 'FormTab.TabPane',
                'x-component-props': {
                  tab: nsT('Advanced Settings'),
                },
                properties: {
                  schema: {
                    type: 'string',
                    title: nsT('Schema'),
                    'x-decorator': 'FormItem',
                    'x-component': 'Input',
                    'x-decorator-props': {
                      tooltip: nsT('PostgreSQL schema name, defaults to public'),
                    },
                    default: DEFAULT_SCHEMA,
                  },
                  ssl: {
                    type: 'boolean',
                    title: nsT('Use SSL'),
                    'x-decorator': 'FormItem',
                    'x-component': 'Checkbox',
                    'x-decorator-props': {
                      tooltip: nsT('Enable SSL/TLS connection'),
                    },
                    default: false,
                  },
                  sslCa: {
                    type: 'string',
                    title: nsT('CA certificate (PEM)'),
                    'x-decorator': 'FormItem',
                    'x-component': 'Input.TextArea',
                    'x-component-props': { rows: 4 },
                  },
                  addAllCollections: {
                    type: 'boolean',
                    title: nsT('Auto Discover Tables'),
                    'x-decorator': 'FormItem',
                    'x-component': 'Checkbox',
                    'x-decorator-props': {
                      tooltip: nsT('Automatically discover tables from the database'),
                    },
                    'x-reactions': {
                      target: 'options.autoDiscover',
                      fulfill: {
                        state: {
                          value: '{{$self.value}}',
                        },
                      },
                    },
                    default: true,
                  },
                  autoDiscover: {
                    type: 'boolean',
                    'x-hidden': true,
                    default: true,
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  return <SchemaComponent schema={schema} components={{ FormTab }} />;
};
