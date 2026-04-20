/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export function createCrossJoinBlockUISchema(config: any) {
  return {
    type: 'void',
    'x-settings': 'blockSettings:crossJoin',
    'x-toolbar': 'BlockSchemaToolbar',
    'x-decorator': 'CrossJoinBlockProvider',
    'x-decorator-props': {
      config,
      params: {
        pageSize: 20,
      },
    },
    'x-component': 'CardItem',
    'x-component-props': {
      name: 'crossJoin',
    },
    properties: {
      table: {
        type: 'void',
        'x-component': 'CrossJoinTable',
      },
    },
  };
}
