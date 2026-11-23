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
import { nsT } from './collection-templates/base-template-helper';
import { POSTGRES_AVAILABLE_INTERFACES } from './collection-templates/field-interfaces-config';

type TemplateManagerArg = ConstructorParameters<typeof CollectionTemplate>[0];
type TemplateDefault = NonNullable<CollectionTemplate['default']>;

export class PostgresGeneralCollectionTemplate extends CollectionTemplate {
  name = 'general';
  title = nsT('General collection');
  order = 1;
  color = 'blue';
  supportDataSourceType = ['postgres-external'];

  constructor(collectionTemplateManager: TemplateManagerArg) {
    super(collectionTemplateManager);

    this.availableFieldInterfaces = POSTGRES_AVAILABLE_INTERFACES;
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
          'Use letters, numbers and underscores, must start with a letter. Example: users, products, orders',
        ),
      },
      description: {
        type: 'string',
        title: nsT('Description'),
        'x-decorator': 'FormItem',
        'x-component': 'Input.TextArea',
      },
      fields: {
        type: 'array',
        title: nsT('Preset fields'),
        description: nsT('Select default fields to include in this collection'),
        'x-decorator': 'FormItem',
        'x-component': 'Checkbox.Group',
        'x-component-props': {
          options: [
            {
              label: nsT('ID - Primary key (auto-increment)'),
              value: 'id',
            },
            {
              label: nsT('Created At - Timestamp when record is created'),
              value: 'createdAt',
            },
            {
              label: nsT('Updated At - Timestamp when record is updated'),
              value: 'updatedAt',
            },
          ],
        },
        default: ['id', 'createdAt', 'updatedAt'],
      },
    };
  }

  _getDefault(): TemplateDefault {
    return {
      fields: ['id', 'createdAt', 'updatedAt'] as unknown as TemplateDefault['fields'],
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
