// SPDX-License-Identifier: Apache-2.0

import { ISchema, useForm } from '@formily/react';
import { SchemaComponent } from '@nocobase/client';
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

const DSM_NAMESPACE = 'data-source-manager';

interface CollectionTableItem {
  name: string;
  selected?: boolean;
  [key: string]: unknown;
}

interface CollectionsTableFieldResult {
  CollectionsTable: React.ComponentType<Record<string, unknown>>;
  Text: React.ComponentType<Record<string, unknown>>;
  addAllCollectionsSchema: ISchema;
  createCollectionsSchema: (from: string, loadCollections: (key: string) => Promise<unknown>) => ISchema;
}

export interface MssqlV1ConfigFormProps {
  CollectionsTableField?: (props: {
    NAMESPACE: string;
    t: (key: string, options?: Record<string, unknown>) => string;
  }) => CollectionsTableFieldResult;
  loadCollections?: (key: string) => Promise<unknown>;
  from?: 'create' | 'edit';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeLoadedCollectionsForV1(
  payload: unknown,
  selectedCollections?: unknown,
  addAllCollections?: unknown,
): { data: CollectionTableItem[] } {
  const rawData =
    isRecord(payload) && Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
  const selectedSet =
    addAllCollections === false && Array.isArray(selectedCollections)
      ? new Set(selectedCollections.filter((item): item is string => typeof item === 'string'))
      : null;

  const items: CollectionTableItem[] = rawData.flatMap((entry: unknown) => {
    if (typeof entry === 'string' && entry) {
      return [{ name: entry, selected: selectedSet ? selectedSet.has(entry) : false }];
    }
    if (isRecord(entry) && typeof entry.name === 'string' && entry.name) {
      const selected = selectedSet ? selectedSet.has(entry.name) : Boolean(entry.selected);
      return [{ ...entry, name: entry.name, selected }];
    }
    return [];
  });

  return { data: items };
}

export const MssqlConfigForm: React.FC<MssqlV1ConfigFormProps> = ({
  CollectionsTableField,
  loadCollections,
  from = 'create',
}) => {
  const { t } = useTranslation('plugin-data-source-mssql');
  const { t: dsmT } = useTranslation(DSM_NAMESPACE);
  const form = useForm();

  const wrappedLoadCollections = useCallback(
    async (key: string) => {
      if (!loadCollections) {
        return { data: [] };
      }
      const response = await loadCollections(key);
      const formOptions = isRecord(form?.values?.options) ? form.values.options : undefined;
      return normalizeLoadedCollectionsForV1(
        response,
        formOptions?.selectedCollections,
        formOptions?.addAllCollections,
      );
    },
    [form, loadCollections],
  );

  const tableField = useMemo(
    () => (CollectionsTableField ? CollectionsTableField({ NAMESPACE: DSM_NAMESPACE, t: dsmT }) : undefined),
    [CollectionsTableField, dsmT],
  );

  const schema = useMemo<ISchema>(() => {
    const addAllSchema: ISchema = tableField?.addAllCollectionsSchema ?? {
      type: 'boolean',
      'x-component': 'Checkbox',
      'x-display': 'hidden',
      default: true,
    };

    const properties: Record<string, ISchema> = {
      key: {
        type: 'string',
        title: dsmT('Data source name'),
        required: true,
        'x-decorator': 'FormItem',
        'x-component': 'Input',
        'x-disabled': from === 'edit',
        'x-validator': [
          {
            pattern: '^[A-Za-z][A-Za-z0-9_]*$',
            message: dsmT(
              'Randomly generated and can be modified. Support letters, numbers and underscores, must start with a letter.',
            ),
          },
        ],
      },
      displayName: {
        type: 'string',
        title: dsmT('Data source display name'),
        required: true,
        'x-decorator': 'FormItem',
        'x-component': 'Input',
      },
      options: {
        type: 'object',
        properties: {
          host: {
            type: 'string',
            title: t('Host'),
            required: true,
            'x-decorator': 'FormItem',
            'x-component': 'Input',
            'x-component-props': {
              placeholder: 'localhost',
            },
          },
          port: {
            type: 'number',
            title: t('Port'),
            required: true,
            default: 1433,
            'x-decorator': 'FormItem',
            'x-component': 'InputNumber',
            'x-component-props': {
              min: 1,
              max: 65535,
              style: { width: '100%' },
            },
          },
          database: {
            type: 'string',
            title: t('Database'),
            required: true,
            'x-decorator': 'FormItem',
            'x-component': 'Input',
          },
          schema: {
            type: 'string',
            title: t('Schema'),
            'x-decorator': 'FormItem',
            'x-component': 'Input',
          },
          username: {
            type: 'string',
            title: t('Username'),
            required: true,
            'x-decorator': 'FormItem',
            'x-component': 'Input',
          },
          password: {
            type: 'string',
            title: t('Password'),
            'x-decorator': 'FormItem',
            'x-component': 'Password',
          },
          encrypt: {
            type: 'boolean',
            'x-decorator': 'FormItem',
            'x-component': 'Checkbox',
            'x-content': t('Encrypt'),
          },
          trustServerCertificate: {
            type: 'boolean',
            default: true,
            'x-decorator': 'FormItem',
            'x-component': 'Checkbox',
            'x-content': t('Trust server certificate'),
          },
          tablePrefix: {
            type: 'string',
            title: t('Table prefix'),
            'x-decorator': 'FormItem',
            'x-component': 'Input',
          },
          addAllCollections: addAllSchema,
        },
      },
      addAllCollections: addAllSchema,
    };

    if (tableField) {
      properties.collections = tableField.createCollectionsSchema(from, wrappedLoadCollections);
    }

    return {
      type: 'object',
      properties,
    };
  }, [dsmT, from, t, tableField, wrappedLoadCollections]);

  const components = useMemo(
    () =>
      tableField
        ? {
            CollectionsTable: tableField.CollectionsTable,
            Text: tableField.Text,
          }
        : undefined,
    [tableField],
  );

  return (
    <SchemaComponent
      schema={schema}
      components={components}
      scope={{ from, loadCollections: wrappedLoadCollections }}
    />
  );
};

export default MssqlConfigForm;
