/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import type { CreateModelOptions } from '@nocobase/flow-engine';
import type { BlockSpec } from '../../shared/blockSpec';
import { createNativeBlockOptions } from '../modelOptions';

const base: BlockSpec = {
  version: 1,
  blockType: 'table',
  title: 'Orders',
  dataSource: 'warehouse',
  primaryCollection: 'orders',
};
const render = (name: string, mode: 'display' | 'edit') => ({
  use: mode === 'edit' ? 'InputFieldModel' : 'DisplayTextFieldModel',
  props: { name },
});
const items = (model: CreateModelOptions, key: string) => model.subModels?.[key] as CreateModelOptions[];
const child = (model: CreateModelOptions, key: string) => model.subModels?.[key] as CreateModelOptions;

describe('V2 native visualization model generation', () => {
  it('creates native table/field models with datasource-aware bindings and sorting without changing the specification', () => {
    const spec: BlockSpec = { ...base, table: { fields: ['name', 'total', 'name'], sortable: ['total'] } };
    const before = JSON.stringify(spec);
    const table = items(
      createNativeBlockOptions(spec, render, () => false),
      'items',
    )[0];
    expect(table.use).toBe('TableBlockModel');
    expect(table.stepParams?.resourceSettings.init).toEqual({ dataSourceKey: 'warehouse', collectionName: 'orders' });
    const columns = items(table, 'columns');
    expect(columns).toHaveLength(2);
    expect(columns[1].stepParams?.fieldSettings.init.fieldPath).toBe('total');
    expect(columns[1].stepParams?.tableColumnSettings.sorter.sorter).toBe(true);
    expect(child(columns[0], 'field').use).toBe('DisplayTextFieldModel');
    expect(JSON.stringify(spec)).toBe(before);
    expect(JSON.stringify(table)).not.toContain('x-component');
  });

  it('restores requested native table actions and binds record popups to the clicked record key', () => {
    const table = items(
      createNativeBlockOptions(
        { ...base, table: { fields: ['name'], actions: ['view', 'edit', 'delete', 'add'] } },
        render,
        () => false,
      ),
      'items',
    )[0];
    expect(items(table, 'actions')[0].use).toBe('AddNewActionModel');
    const actions = items(items(table, 'columns')[1], 'actions');
    expect(actions.map((action) => action.use)).toEqual(['ViewActionModel', 'EditActionModel', 'DeleteActionModel']);
    const tab = items(child(actions[1], 'page'), 'tabs')[0];
    const form = items(child(tab, 'grid'), 'items')[0];
    expect(form.stepParams?.resourceSettings.init.filterByTk).toBe('{{ctx.view.inputArgs.filterByTk}}');
    expect(items(form, 'actions')[0].use).toBe('FormSubmitActionModel');
  });

  it('keeps standalone edit forms paginated and create forms free of another record key', () => {
    const edit = items(
      createNativeBlockOptions(
        { ...base, blockType: 'form', form: { fields: ['name'], mode: 'edit' } },
        render,
        () => false,
      ),
      'items',
    )[0];
    expect(edit.use).toBe('EditFormModel');
    expect(edit.stepParams?.resourceSettings.init).not.toHaveProperty('filterByTk');
    const create = items(
      createNativeBlockOptions(
        { ...base, blockType: 'form', form: { fields: ['name'], mode: 'create' } },
        render,
        () => false,
      ),
      'items',
    )[0];
    expect(create.use).toBe('CreateFormModel');
    expect(child(items(child(create, 'grid'), 'items')[0], 'field').use).toBe('InputFieldModel');
  });

  it('uses a popup record key only when the datasource and collection match the generated edit form', () => {
    const spec: BlockSpec = { ...base, blockType: 'form', form: { fields: ['name'], mode: 'edit' } };
    const context = { dataSourceKey: 'warehouse', collectionName: 'orders', filterByTk: '9007199254740993' };
    const options = createNativeBlockOptions(spec, render, () => false, true, context);
    expect(items(options, 'items')[0].stepParams?.resourceSettings.init.filterByTk).toBe(
      '{{ctx.view.inputArgs.filterByTk}}',
    );
    for (const mismatch of [
      { ...context, collectionName: 'customers' },
      { ...context, dataSourceKey: 'main' },
    ]) {
      expect(
        items(
          createNativeBlockOptions(spec, render, () => false, true, mismatch),
          'items',
        )[0].stepParams?.resourceSettings.init,
      ).not.toHaveProperty('filterByTk');
    }
  });

  it('omits mutation and popup actions from previews', () => {
    const table = items(
      createNativeBlockOptions(
        { ...base, table: { fields: ['name'], actions: ['add', 'delete', 'edit', 'view'] } },
        render,
        () => false,
        false,
      ),
      'items',
    )[0];
    expect(items(table, 'actions')).toEqual([]);
    expect(items(table, 'columns')).toHaveLength(1);
    const form = items(
      createNativeBlockOptions({ ...base, blockType: 'form', form: { fields: ['name'] } }, render, () => false, false),
      'items',
    )[0];
    expect(items(form, 'actions')).toEqual([]);
  });

  it('maps legacy chart types to native V2 configuration and uses query result aliases for axes', () => {
    const root = createNativeBlockOptions(
      {
        ...base,
        blockType: 'chart',
        charts: [
          {
            key: 'sales',
            title: 'Sales',
            chartType: 'ant-design-charts.column',
            measures: [{ field: 'total', aggregation: 'sum', alias: 'sales' }],
            dimensions: [{ field: 'createdAt', alias: 'month', format: 'YYYY-MM' }],
            config: { xField: 'createdAt', yField: 'total' },
          },
        ],
      },
      render,
      () => false,
    );
    const chart = items(root, 'items')[0];
    expect(chart.use).toBe('ChartBlockModel');
    const config = chart.stepParams?.chartSettings.configure;
    expect(config.query.collectionPath).toEqual(['warehouse', 'orders']);
    expect(config.query.dimensions[0].format).toBe('YYYY-MM');
    expect(config.chart.option.builder).toMatchObject({ type: 'bar', xField: 'month', yField: 'sales' });
  });

  it('uses registered chart plugins and safely renders a statistic without treating generated text as executable code', () => {
    const spec: BlockSpec = {
      ...base,
      blockType: 'chart',
      charts: [
        {
          key: 'total',
          title: 'Total',
          chartType: 'antd.statistic',
          measures: [{ field: 'id', alias: 'a"; dangerous() //', aggregation: 'count' }],
        },
      ],
    };
    const statistic = items(
      createNativeBlockOptions(spec, render, () => false),
      'items',
    )[0];
    const raw = statistic.stepParams?.chartSettings.configure.chart.option.raw;
    expect(raw).toContain('["a\\"; dangerous() //"]');
    const registered = items(
      createNativeBlockOptions(spec, render, () => true),
      'items',
    )[0];
    expect(registered.stepParams?.chartSettings.configure.chart.option.builder.type).toBe('antd.statistic');
  });

  it('refuses unsupported or empty output instead of inserting a legacy schema or an unrelated chart', () => {
    expect(() => createNativeBlockOptions({ ...base, table: { fields: [] } }, render, () => false)).toThrow(
      'No compatible field renderer',
    );
    expect(() =>
      createNativeBlockOptions(
        {
          ...base,
          blockType: 'chart',
          charts: [{ key: 'x', title: 'x', chartType: 'unknown', measures: [{ field: 'id', alias: 'count' }] }],
        },
        render,
        () => false,
      ),
    ).toThrow('No compatible chart configuration');
  });
});
