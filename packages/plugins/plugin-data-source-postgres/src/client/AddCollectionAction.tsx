/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useMemo, useState } from 'react';
import { ArrayItems, Space } from '@formily/antd-v5';
import { type ISchema, useForm, useField } from '@formily/react';
import { cloneDeep, uniqueId } from 'lodash';
import {
  useAPIClient,
  useActionContext,
  useDataSourceManager,
  useRecord,
  useCompile,
  useCollectionManager_deprecated,
  useCancelAction,
  useResourceActionContext,
  SchemaComponent,
  ActionContextProvider,
  RecordProvider,
  useRequest,
  type CollectionTemplate,
} from '@nocobase/client';
import { useParams } from 'react-router-dom';
import { Button, Dropdown, message, type MenuProps } from 'antd';
import { PlusOutlined, DownOutlined } from '@ant-design/icons';
import {
  PostgresGeneralCollectionTemplate,
  PostgresCalendarCollectionTemplate,
  PostgresTreeCollectionTemplate,
  PostgresFileCollectionTemplate,
  PostgresSQLCollectionTemplate,
} from './collection-templates';
import { nsT } from './collection-templates/base-template-helper';

type SqlFieldType = 'string' | 'text' | 'integer' | 'bigInt' | 'decimal' | 'boolean' | 'date' | 'json' | 'uuid';

const SQL_FIELD_INTERFACES: Record<SqlFieldType, string> = {
  string: 'input',
  text: 'textarea',
  integer: 'integer',
  bigInt: 'integer',
  decimal: 'number',
  boolean: 'checkbox',
  date: 'datetime',
  json: 'json',
  uuid: 'uuid',
};

type SqlFieldInput = { name?: string; type?: SqlFieldType };
type FieldLike = Record<string, unknown> & { name?: string; type?: string; target?: string };
type CollectionRecordLike = Record<string, unknown> & { key?: string; name?: string };
type PostgresAddCollectionProps = {
  scope?: Record<string, unknown>;
  getContainer?: () => HTMLElement;
  item?: CollectionRecordLike;
  children?: React.ReactNode;
  trigger?: ('click' | 'hover' | 'contextMenu')[];
  type?: 'primary' | 'default' | 'dashed' | 'link' | 'text';
};

/**
 * Get schema for collection creation form
 */
const getSchema = (schema: CollectionTemplate | undefined, category: string | null): ISchema | undefined => {
  if (!schema) {
    return undefined;
  }

  const properties = cloneDeep(schema.configurableProperties || {}) as Record<string, Record<string, unknown>>;

  if (properties.name) {
    properties.name['x-disabled'] = false;
    properties.name['x-read-only'] = false;
    const componentProps = (properties.name['x-component-props'] as Record<string, unknown> | undefined) || {};
    properties.name['x-component-props'] = {
      ...componentProps,
      disabled: false,
      readOnly: false,
      placeholder: `t_${uniqueId()}`,
    };
  }

  const initialValue: Record<string, unknown> = {
    template: schema.name,
    category: category || null,
    ...cloneDeep(schema.default || {}),
  };

  return {
    type: 'object',
    properties: {
      [uniqueId()]: {
        type: 'void',
        'x-component': 'Action.Drawer',
        'x-component-props': {
          getContainer: '{{ getContainer }}',
        },
        'x-decorator': 'Form',
        'x-decorator-props': {
          useValues(options: Record<string, unknown>) {
            return useRequest(
              () =>
                Promise.resolve({
                  data: initialValue,
                }),
              options,
            );
          },
        },
        title: nsT('Create collection'),
        properties: {
          summary: {
            type: 'void',
            'x-component': 'TemplateSummay',
            'x-component-props': {
              schemaKey: schema.name,
            },
          },
          ...(properties as Record<string, ISchema>),
          footer: {
            type: 'void',
            'x-component': 'Action.Drawer.Footer',
            properties: {
              action1: {
                title: nsT('Cancel'),
                'x-component': 'Action',
                'x-component-props': {
                  useAction: '{{ useCancelAction }}',
                },
              },
              action2: {
                title: nsT('Submit'),
                'x-component': 'Action',
                'x-component-props': {
                  type: 'primary',
                  useAction: '{{ useCreatePostgresCollection }}',
                },
              },
            },
          },
        },
      },
    },
  };
};

/**
 * Custom hook for creating collections in PostgreSQL datasources
 */
const useCreatePostgresCollection = () => {
  const form = useForm();
  const { refreshCM } = useCollectionManager_deprecated();
  const resourceAction = useResourceActionContext();
  const ctx = useActionContext();
  const { name: dataSourceKey } = useParams<{ name?: string }>();
  const api = useAPIClient();
  const dm = useDataSourceManager();
  const field = useField();

  return {
    async run() {
      field.data = field.data || {};
      field.data.loading = true;

      try {
        await form.submit();
        const values = cloneDeep(form.values) as Record<string, unknown> & {
          name?: string;
          template?: string;
          fields?: (FieldLike | string)[];
          sqlFields?: SqlFieldInput[];
        };

        if (values.template === 'sql' && Array.isArray(values.sqlFields)) {
          values.fields = values.sqlFields
            .filter((item): item is { name: string; type?: SqlFieldType } => Boolean(item?.name?.trim()))
            .map(({ name, type }) => {
              const fieldType: SqlFieldType = type && type in SQL_FIELD_INTERFACES ? type : 'string';
              return {
                name: name.trim(),
                type: fieldType,
                interface: SQL_FIELD_INTERFACES[fieldType],
              };
            });
          delete values.sqlFields;
        }

        if (values.template === 'general' && Array.isArray(values.fields)) {
          const selected = new Set(values.fields.map((item) => (typeof item === 'string' ? item : item?.name)));
          values.autoGenId = selected.has('id');
          values.createdAt = selected.has('createdAt');
          values.updatedAt = selected.has('updatedAt');
        }

        if (values.template === 'tree' && Array.isArray(values.fields) && typeof values.name === 'string') {
          values.fields = values.fields.map((item) => {
            if (typeof item === 'object' && item !== null && (item.type === 'belongsTo' || item.type === 'hasMany')) {
              return item.target ? item : { ...item, target: values.name };
            }
            return item;
          });
        }

        await api.request({
          url: `dataSources/${encodeURIComponent(dataSourceKey || '')}/collections:create`,
          method: 'post',
          data: {
            logging: true,
            ...values,
          },
        });

        ctx.setVisible(false);
        await form.reset();

        const dataSource = dm.getDataSource(dataSourceKey);
        if (dataSource) {
          await dataSource.reload();
        }
        await refreshCM();
        await resourceAction?.refresh?.();
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error || 'Failed to create collection');
        message.error(errorText);
      } finally {
        field.data.loading = false;
      }
    },
  };
};

/**
 * Custom AddCollection component for PostgreSQL datasources
 */
export const PostgresAddCollectionAction: React.FC<PostgresAddCollectionProps> = (props) => {
  const { scope, getContainer, item: record, children, trigger } = props;
  const dataSourceManager = useDataSourceManager();
  const [visible, setVisible] = useState(false);
  const [schema, setSchema] = useState<ISchema>({});
  const compile = useCompile();

  const allTemplates = useMemo<CollectionTemplate[]>(() => {
    const templateManager = dataSourceManager?.collectionTemplateManager;
    return [
      new PostgresGeneralCollectionTemplate(templateManager),
      new PostgresCalendarCollectionTemplate(templateManager),
      new PostgresTreeCollectionTemplate(templateManager),
      new PostgresFileCollectionTemplate(templateManager),
      new PostgresSQLCollectionTemplate(templateManager),
    ];
  }, [dataSourceManager]);

  const items = useMemo<MenuProps['items']>(() => {
    return allTemplates.map((template) => ({
      label: compile(template.title),
      key: template.name,
    }));
  }, [allTemplates, compile]);

  return (
    <RecordProvider record={record}>
      <ActionContextProvider value={{ visible, setVisible }}>
        <Dropdown
          trigger={trigger}
          menu={{
            onClick: (info) => {
              const selectedTemplate = allTemplates.find((t) => t.name === info.key);
              const nextSchema = getSchema(selectedTemplate, record?.key || record?.name || null);
              if (nextSchema) {
                setSchema(nextSchema);
                setVisible(true);
              }
            },
            items,
          }}
        >
          {children || (
            <Button icon={<PlusOutlined />} type={props.type}>
              {compile(nsT('Create collection'))} <DownOutlined />
            </Button>
          )}
        </Dropdown>
        <SchemaComponent
          schema={schema}
          components={{ ArrayItems, Space }}
          scope={{
            getContainer,
            useCancelAction,
            useCreatePostgresCollection,
            ...scope,
          }}
        />
      </ActionContextProvider>
    </RecordProvider>
  );
};

export const PostgresAddCollection: React.FC<PostgresAddCollectionProps> = (props) => {
  const record = useRecord() as CollectionRecordLike | undefined;
  return <PostgresAddCollectionAction item={record} {...props} />;
};
