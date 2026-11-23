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
import { nsT, TREE_FIELD_INTERFACES } from './base-template-helper';

type TemplateManagerArg = ConstructorParameters<typeof CollectionTemplate>[0];
type TemplateDefault = NonNullable<CollectionTemplate['default']>;

/**
 * Tree Collection Template for PostgreSQL
 * Collections with parent-child relationships for tree structures
 */
export class PostgresTreeCollectionTemplate extends CollectionTemplate {
  name = 'tree';
  title = nsT('Tree collection');
  order = 3;
  color = 'green';
  supportDataSourceType = ['postgres-external'];
  description = nsT('Collections organized in parent-child tree structure, like categories, departments, etc');

  constructor(collectionTemplateManager: TemplateManagerArg) {
    super(collectionTemplateManager);

    this.availableFieldInterfaces = TREE_FIELD_INTERFACES;
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
          'Use letters, numbers and underscores, must start with a letter. Example: categories, departments',
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
          name: 'name',
          type: 'string',
          interface: 'input',
          uiSchema: {
            type: 'string',
            title: nsT('Name'),
            'x-component': 'Input',
            required: true,
          },
        },
        {
          name: 'parentId',
          type: 'bigInt',
          interface: 'integer',
        },
        {
          name: 'parent',
          type: 'belongsTo',
          interface: 'm2o',
          foreignKey: 'parentId',
          targetKey: 'id',
          treeParent: true,
        },
        {
          name: 'children',
          type: 'hasMany',
          interface: 'o2m',
          foreignKey: 'parentId',
          sourceKey: 'id',
          treeChildren: true,
        },
      ],
      tree: 'parentId',
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
