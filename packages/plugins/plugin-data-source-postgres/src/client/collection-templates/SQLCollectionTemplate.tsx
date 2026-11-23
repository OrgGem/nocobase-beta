/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { ISchema } from '@formily/react';
import { CollectionTemplate } from '@nocobase/client';
import { NAMESPACE } from '../../constants';
import { nsT, SQL_FIELD_INTERFACES } from './base-template-helper';

type TemplateManagerArg = ConstructorParameters<typeof CollectionTemplate>[0];
type TemplateDefault = NonNullable<CollectionTemplate['default']> & {
  sqlFields?: Array<{ name: string; type: string }>;
};

/**
 * SQL Collection Template for PostgreSQL
 * Collections created from custom SQL queries (similar to views)
 */
export class PostgresSQLCollectionTemplate extends CollectionTemplate {
  name = 'sql';
  title = nsT('SQL collection');
  order = 5;
  color = 'cyan';
  supportDataSourceType = ['postgres-external'];
  description = nsT('Collections created from custom SQL queries, read-only by default');

  constructor(collectionTemplateManager: TemplateManagerArg) {
    super(collectionTemplateManager);

    this.availableFieldInterfaces = SQL_FIELD_INTERFACES;
    this.configurableProperties = this._getConfigurableProperties();
    this.default = this._getDefault();
  }

  private translate(key: string): string {
    const manager = this.collectionTemplateManager as
      | { dataSourceManager?: { app?: { i18n?: { t: (k: string, opts?: Record<string, unknown>) => string } } } }
      | undefined;
    return manager?.dataSourceManager?.app?.i18n?.t(key, { ns: NAMESPACE }) || key;
  }

  _getConfigurableProperties(): Record<string, ISchema> {
    return {
      title: {
        type: 'string',
        title: nsT('Collection display name'),
        required: true,
        'x-decorator': 'FormItem',
        'x-component': 'Input',
      },
      name: {
        type: 'string',
        title: nsT('Collection name'),
        required: true,
        'x-decorator': 'FormItem',
        'x-component': 'Input',
        'x-disabled': false,
        'x-read-only': false,
        'x-component-props': {
          disabled: false,
          placeholder: nsT('Please input collection name'),
        },
        'x-validator': [
          {
            pattern: /^[a-zA-Z][a-zA-Z0-9_]*$/,
            message: nsT('Must start with a letter and can only contain letters, numbers, and underscores'),
          },
        ],
        description: nsT(
          'Use letters, numbers and underscores, must start with a letter. Example: analytics, reports, queries',
        ),
      },
      sql: {
        type: 'string',
        title: nsT('SQL query'),
        required: true,
        'x-decorator': 'FormItem',
        'x-component': 'Input.TextArea',
        'x-component-props': {
          rows: 10,
          placeholder: nsT('SELECT * FROM your_table WHERE ...'),
        },
        description: nsT(
          'Custom SQL query to retrieve data. Must be a SELECT statement. The collection will be read-only.',
        ),
      },
      sqlFields: {
        type: 'array',
        title: nsT('Query columns'),
        'x-decorator': 'FormItem',
        'x-component': 'ArrayItems',
        'x-validator': (value: Array<{ name?: string }> = []) => {
          if (!Array.isArray(value) || value.length === 0) {
            return this.translate('Add at least one query column');
          }
          const names = value.map((item) => item?.name?.trim()).filter(Boolean);
          if (names.length !== value.length) {
            return this.translate('Column name is required');
          }
          if (new Set(names).size !== names.length) {
            return this.translate('Column names must be unique');
          }
          return '';
        },
        items: {
          type: 'object',
          'x-component': 'Space',
          properties: {
            name: {
              type: 'string',
              required: true,
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': {
                placeholder: nsT('Column name'),
              },
            },
            type: {
              type: 'string',
              required: true,
              default: 'string',
              'x-decorator': 'FormItem',
              'x-component': 'Select',
              'x-component-props': {
                style: { width: 150 },
              },
              enum: [
                { value: 'string', label: nsT('Text') },
                { value: 'text', label: nsT('Long text') },
                { value: 'integer', label: nsT('Integer') },
                { value: 'bigInt', label: nsT('Big integer') },
                { value: 'decimal', label: nsT('Decimal') },
                { value: 'boolean', label: nsT('Boolean') },
                { value: 'date', label: nsT('Date and time') },
                { value: 'json', label: nsT('JSON') },
                { value: 'uuid', label: nsT('UUID') },
              ],
            },
            remove: {
              type: 'void',
              'x-decorator': 'FormItem',
              'x-component': 'ArrayItems.Remove',
            },
          },
        },
        properties: {
          addition: {
            type: 'void',
            title: nsT('Add query column'),
            'x-component': 'ArrayItems.Addition',
            'x-component-props': {
              defaultValue: { name: '', type: 'string' },
            },
          },
        },
      },
      description: {
        type: 'string',
        title: nsT('Description'),
        'x-decorator': 'FormItem',
        'x-component': 'Input.TextArea',
      },
    };
  }

  _getDefault(): TemplateDefault {
    return {
      fields: [],
      sqlFields: [{ name: '', type: 'string' }],
      autoGenId: false,
      createdBy: false,
      updatedBy: false,
      createdAt: false,
      updatedAt: false,
      sortable: false,
      logging: false,
    };
  }
}
