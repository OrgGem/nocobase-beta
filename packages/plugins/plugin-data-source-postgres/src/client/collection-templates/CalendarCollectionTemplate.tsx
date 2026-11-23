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
import { CALENDAR_FIELD_INTERFACES, nsT } from './base-template-helper';

type TemplateManagerArg = ConstructorParameters<typeof CollectionTemplate>[0];
type TemplateDefault = NonNullable<CollectionTemplate['default']>;

/**
 * Calendar Collection Template for PostgreSQL
 * Collections with start/end date fields for calendar view
 */
export class PostgresCalendarCollectionTemplate extends CollectionTemplate {
  name = 'calendar';
  title = nsT('Calendar collection');
  order = 2;
  color = 'orange';
  supportDataSourceType = ['postgres-external'];
  description = nsT('Collections used for calendar events, with start and end date fields');

  constructor(collectionTemplateManager: TemplateManagerArg) {
    super(collectionTemplateManager);

    this.availableFieldInterfaces = CALENDAR_FIELD_INTERFACES;
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
          'Use letters, numbers and underscores, must start with a letter. Example: events, meetings, tasks',
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
          name: 'title',
          type: 'string',
          interface: 'input',
          uiSchema: {
            type: 'string',
            title: nsT('Title'),
            'x-component': 'Input',
            required: true,
          },
        },
        {
          name: 'start',
          type: 'date',
          interface: 'datetime',
          uiSchema: {
            type: 'string',
            title: nsT('Start date'),
            'x-component': 'DatePicker',
            'x-component-props': {
              showTime: true,
            },
            required: true,
          },
        },
        {
          name: 'end',
          type: 'date',
          interface: 'datetime',
          uiSchema: {
            type: 'string',
            title: nsT('End date'),
            'x-component': 'DatePicker',
            'x-component-props': {
              showTime: true,
            },
          },
        },
      ],
      autoGenId: true,
      createdBy: false,
      updatedBy: false,
      createdAt: true,
      updatedAt: true,
      sortable: true,
      logging: false,
    };
  }
}
