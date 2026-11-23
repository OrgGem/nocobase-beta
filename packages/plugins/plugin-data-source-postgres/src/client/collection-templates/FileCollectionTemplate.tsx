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
import { FILE_FIELD_INTERFACES, nsT } from './base-template-helper';

type TemplateManagerArg = ConstructorParameters<typeof CollectionTemplate>[0];
type TemplateDefault = NonNullable<CollectionTemplate['default']>;

/**
 * File Collection Template for PostgreSQL
 * Collections for file/attachment management
 */
export class PostgresFileCollectionTemplate extends CollectionTemplate {
  name = 'file';
  title = nsT('File collection');
  order = 4;
  color = 'purple';
  supportDataSourceType = ['postgres-external'];
  description = nsT('Collections for storing file metadata and attachments');

  constructor(collectionTemplateManager: TemplateManagerArg) {
    super(collectionTemplateManager);

    this.availableFieldInterfaces = FILE_FIELD_INTERFACES;
    this.configurableProperties = this._getConfigurableProperties();
    this.default = this._getDefault();
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
          'Use letters, numbers and underscores, must start with a letter. Example: documents, images, attachments',
        ),
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
      fields: [
        {
          name: 'id',
          type: 'bigInt',
          interface: 'id',
          primaryKey: true,
          autoIncrement: true,
          uiSchema: {
            type: 'number',
            title: nsT('ID'),
            'x-component': 'InputNumber',
            'x-read-pretty': true,
          },
        },
        {
          name: 'filename',
          type: 'string',
          interface: 'input',
          uiSchema: {
            type: 'string',
            title: nsT('Filename'),
            'x-component': 'Input',
            required: true,
          },
        },
        {
          name: 'title',
          type: 'string',
          interface: 'input',
          uiSchema: {
            type: 'string',
            title: nsT('Title'),
            'x-component': 'Input',
          },
        },
        {
          name: 'url',
          type: 'string',
          interface: 'url',
          uiSchema: {
            type: 'string',
            title: nsT('URL'),
            'x-component': 'Input.URL',
          },
        },
        {
          name: 'mimetype',
          type: 'string',
          interface: 'input',
          uiSchema: {
            type: 'string',
            title: nsT('MIME type'),
            'x-component': 'Input',
          },
        },
        {
          name: 'size',
          type: 'bigInt',
          interface: 'integer',
          uiSchema: {
            type: 'number',
            title: nsT('File size'),
            'x-component': 'InputNumber',
          },
        },
      ],
      autoGenId: true,
      createdBy: false,
      updatedBy: false,
      createdAt: true,
      updatedAt: true,
      sortable: false,
      logging: false,
    };
  }
}
