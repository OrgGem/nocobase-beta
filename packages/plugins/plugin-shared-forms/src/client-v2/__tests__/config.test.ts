/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import {
  collectionBinding,
  configuredFields,
  legacyFields,
  parseConfig,
  type SharedFormConfig,
} from '../../shared/v2Config';
import { formModelOptions } from '../models';

describe('Shared Forms V2 configuration contract', () => {
  it('keeps the existing datasource:collection encoding and rejects mismatched model bindings', () => {
    expect(collectionBinding('orders')).toEqual({ dataSourceKey: 'main', collectionName: 'orders' });
    const config = { version: 2, model: formModelOptions('crm', 'orders'), successMessage: 'Done' };
    expect(parseConfig(config, 'crm:orders')).toBe(config);
    expect(() => parseConfig(config, 'main:orders')).toThrow('Form collection does not match');
  });
  it('derives submission fields from configured form items and excludes unrelated popup/actions', () => {
    const config = { version: 2, model: formModelOptions('main', 'orders'), successMessage: '' } as SharedFormConfig;
    config.model.subModels.grid = {
      use: 'FormGridModel',
      subModels: {
        items: [
          {
            use: 'FormItemModel',
            stepParams: {
              fieldSettings: { init: { dataSourceKey: 'main', collectionName: 'orders', fieldPath: 'title' } },
            },
          },
          {
            use: 'FormItemModel',
            stepParams: {
              fieldSettings: { init: { dataSourceKey: 'main', collectionName: 'orders', fieldPath: 'lines.name' } },
            },
          },
          {
            use: 'FormItemModel',
            stepParams: {
              fieldSettings: { init: { dataSourceKey: 'main', collectionName: 'orders', fieldPath: '__proto__.bad' } },
            },
          },
          {
            use: 'FormItemModel',
            stepParams: {
              fieldSettings: { init: { dataSourceKey: 'main', collectionName: 'customers', fieldPath: 'password' } },
            },
          },
        ],
      },
    };
    config.model.subModels.actions = [
      {
        use: 'FormItemModel',
        stepParams: {
          fieldSettings: { init: { dataSourceKey: 'main', collectionName: 'orders', fieldPath: 'secret' } },
        },
      },
    ];
    expect(configuredFields(config.model)).toEqual(['title', 'lines']);
  });
  it('copies field choices from V1 without changing the legacy schema or claiming to migrate complex rules', () => {
    const schema = {
      properties: {
        field: {
          'x-collection-field': 'orders.title',
          properties: { nested: { 'x-collection-field': 'other.password' } },
        },
        duplicate: { 'x-collection-field': 'orders.title' },
      },
    };
    const before = JSON.stringify(schema);
    expect(legacyFields(schema, 'orders')).toEqual(['title']);
    expect(JSON.stringify(schema)).toBe(before);
  });
  it('rejects a legacy root and malformed nested model trees before storage', () => {
    expect(() =>
      parseConfig({ version: 2, model: { use: 'CreateFormModel' }, successMessage: '' }, 'orders'),
    ).toThrow();
    const config = { version: 2, model: formModelOptions('main', 'orders'), successMessage: '' };
    config.model.subModels.grid = { use: 'FormGridModel', subModels: { items: [null] } } as never;
    expect(() => parseConfig(config, 'orders')).toThrow('Invalid V2 form configuration');
  });
});
