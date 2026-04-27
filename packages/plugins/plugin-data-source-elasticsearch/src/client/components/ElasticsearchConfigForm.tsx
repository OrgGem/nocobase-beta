/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback } from 'react';
import { SchemaComponent, useAPIClient } from '@nocobase/client';
import { useForm } from '@formily/react';
import { message } from 'antd';
import { useTranslation } from 'react-i18next';

type CollectionsFieldFactoryResult = {
  CollectionsTable: React.ComponentType<any>;
  createCollectionsSchema: (from?: 'create' | 'edit', loadCollections?: (key: string) => Promise<any>) => any;
  Text: React.ComponentType<any>;
  addAllCollectionsSchema?: any;
};

type CollectionsFieldFactory = (params: { NAMESPACE: string; t: any }) => CollectionsFieldFactoryResult;

type ElasticsearchConfigFormProps = {
  CollectionsTableField: CollectionsFieldFactory;
  loadCollections: (key: string) => Promise<any>;
  from?: 'create' | 'edit';
};

export const ElasticsearchConfigForm: React.FC<ElasticsearchConfigFormProps> = ({
  CollectionsTableField,
  loadCollections,
  from,
}) => {
  const api = useAPIClient();
  const form = useForm();
  const { t } = useTranslation();
  const NAMESPACE = 'data-source-manager';
  const { CollectionsTable, createCollectionsSchema, Text, addAllCollectionsSchema } = CollectionsTableField({
    NAMESPACE,
    t,
  });

  const handleTestConnection = useCallback(async () => {
    await form.submit();
    const values = form.values;

    try {
      await api.request({
        url: 'external-elasticsearch:testConnection',
        method: 'post',
        data: values,
      });
      message.success(t('Connection successful'));
    } catch (error) {
      const errMessage = error?.response?.data?.message || error.message;
      message.error(errMessage);
    }
  }, [api, form, t]);

  return (
    <SchemaComponent
      scope={{
        CollectionsTableField,
        loadCollections,
        handleTestConnection,
        from,
        t,
        CollectionsTable,
        createCollectionsSchema,
        Text,
        addAllCollectionsSchema,
      }}
      components={{ CollectionsTable, Text }}
      schema={{
        type: 'object',
        properties: {
          type: {
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': 'Input',
            'x-hidden': true,
          },
          key: {
            type: 'string',
            title: t('Data source name'),
            required: true,
            'x-decorator': 'FormItem',
            'x-component': 'Input',
          },
          displayName: {
            type: 'string',
            title: t('Display name'),
            required: true,
            'x-decorator': 'FormItem',
            'x-component': 'Input',
          },
          options: {
            type: 'object',
            properties: {
              nodes: {
                type: 'string',
                title: t('Elasticsearch Nodes'),
                required: true,
                'x-decorator': 'FormItem',
                'x-component': 'Input',
                'x-component-props': {
                  placeholder: 'http://localhost:9200',
                },
                description: t('Comma-separated list of Elasticsearch node URLs'),
              },
              username: {
                type: 'string',
                title: t('Username'),
                'x-decorator': 'FormItem',
                'x-component': 'Input',
                description: t('Optional. For Basic authentication.'),
              },
              password: {
                type: 'string',
                title: t('Password'),
                'x-decorator': 'FormItem',
                'x-component': 'Password',
              },
              apiKey: {
                type: 'string',
                title: t('API Key'),
                'x-decorator': 'FormItem',
                'x-component': 'Input',
                description: t('API Key description'),
              },
              rejectUnauthorized: {
                type: 'boolean',
                title: t('Verify TLS Certificate'),
                'x-decorator': 'FormItem',
                'x-component': 'Checkbox',
                default: true,
                description: t('Uncheck for self-signed certificates'),
              },
              indexPattern: {
                type: 'string',
                title: t('Index Pattern'),
                'x-decorator': 'FormItem',
                'x-component': 'Input',
                'x-component-props': {
                  placeholder: '*',
                },
                description: t('Filter indices by pattern (e.g. logs-*, my-data-*)'),
              },
              addAllCollections: {
                type: 'boolean',
                title: t('Load all collections'),
                'x-decorator': 'FormItem',
                'x-component': 'Checkbox',
                default: true,
              },
              collections: createCollectionsSchema(from, loadCollections),
            },
          },
        },
      }}
    />
  );
};

export default ElasticsearchConfigForm;
