/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { CreateModelOptions } from '@nocobase/flow-engine';
import type { BlockSpec, ChartSpecItem } from '../shared/blockSpec';

export type FieldRenderer = (field: string, mode: 'display' | 'edit') => CreateModelOptions;

const binding = (spec: BlockSpec) => ({ dataSourceKey: spec.dataSource, collectionName: spec.primaryCollection });
const title = (value: string) => ({ cardSettings: { titleDescription: { title: value } } });
const grid = (items: CreateModelOptions[]): CreateModelOptions => ({ use: 'BlockGridModel', subModels: { items } });

function chartOptions(chart: ChartSpecItem, spec: BlockSpec, hasChart: (name: string) => boolean): CreateModelOptions {
  if (!chart.measures.length) throw new Error('No compatible chart configuration');
  const measures = chart.measures.map((measure) => ({ ...measure, aggregation: measure.aggregation || 'count' }));
  const dimensions = (chart.dimensions || []).map((dimension) => ({
    ...dimension,
    alias: dimension.alias || dimension.field,
  }));
  const config = { ...chart.config };
  const column = (value: unknown, fallback?: string) => {
    if (typeof value !== 'string') return fallback;
    return (
      measures.find((item) => item.field === value)?.alias ||
      dimensions.find((item) => item.field === value)?.alias ||
      value
    );
  };
  let option: Record<string, unknown>;
  if (hasChart(chart.chartType)) {
    option = { mode: 'basic', builder: { ...config, type: chart.chartType } };
  } else if (chart.chartType === 'antd.statistic') {
    const field = column(config.field, measures[0].alias);
    option = {
      mode: 'custom',
      raw: `const rows = ctx.data?.objects || [];
const value = rows[0]?.[${JSON.stringify(field)}] ?? 0;
return { graphic: { type: 'text', left: 'center', top: 'middle', style: { text: String(value), fontSize: 36 } } };`,
    };
  } else {
    const types: Record<string, string> = {
      'ant-design-charts.line': 'line',
      'ant-design-charts.column': 'bar',
      'ant-design-charts.bar': 'barHorizontal',
      'ant-design-charts.pie': 'pie',
      'ant-design-charts.area': 'area',
      'ant-design-charts.scatter': 'scatter',
      'ant-design-charts.funnel': 'funnel',
    };
    const type = types[chart.chartType];
    if (!type) throw new Error('No compatible chart configuration');
    const x = column(config.xField, dimensions[0]?.alias),
      y = column(config.yField, measures[0].alias);
    option = {
      mode: 'basic',
      builder: {
        ...config,
        type,
        xField: x,
        yField: y,
        seriesField: column(config.seriesField, dimensions[1]?.alias),
        pieCategory: column(config.colorField, dimensions[0]?.alias),
        pieValue: column(config.angleField, measures[0].alias),
        pieRadiusInner: typeof config.innerRadius === 'number' ? config.innerRadius * 100 : 0,
        funnelCategory: column(config.xField, dimensions[0]?.alias),
        funnelValue: column(config.yField, measures[0].alias),
      },
    };
  }
  return {
    use: 'ChartBlockModel',
    stepParams: {
      ...title(chart.title),
      chartSettings: {
        configure: {
          query: { mode: 'builder', collectionPath: [spec.dataSource, spec.primaryCollection], measures, dimensions },
          chart: { option },
        },
      },
    },
  };
}

function formOptions(
  spec: BlockSpec,
  fields: string[],
  renderField: FieldRenderer,
  mode: 'create' | 'edit' | 'details',
  actions: boolean,
): CreateModelOptions {
  const init: Record<string, unknown> = binding(spec);
  if (mode !== 'create') init.filterByTk = '{{ctx.view.inputArgs.filterByTk}}';
  return {
    use: mode === 'create' ? 'CreateFormModel' : mode === 'edit' ? 'EditFormModel' : 'DetailsBlockModel',
    stepParams: { ...title(spec.title), resourceSettings: { init } },
    subModels: {
      grid: {
        use: mode === 'details' ? 'DetailsGridModel' : 'FormGridModel',
        subModels: {
          items: fields.map((field) => ({
            use: mode === 'details' ? 'DetailsItemModel' : 'FormItemModel',
            stepParams: { fieldSettings: { init: { ...binding(spec), fieldPath: field } } },
            subModels: { field: renderField(field, mode === 'details' ? 'display' : 'edit') },
          })),
        },
      },
      actions: mode !== 'details' && actions ? [{ use: 'FormSubmitActionModel' }] : [],
    },
  };
}

function popupAction(
  spec: BlockSpec,
  fields: string[],
  renderField: FieldRenderer,
  mode: 'create' | 'edit' | 'details',
): CreateModelOptions {
  return {
    use: mode === 'create' ? 'AddNewActionModel' : mode === 'edit' ? 'EditActionModel' : 'ViewActionModel',
    stepParams: { popupSettings: { openView: binding(spec) } },
    subModels: {
      page: {
        use: 'ChildPageModel',
        stepParams: { pageSettings: { general: { displayTitle: false, enableTabs: false } } },
        subModels: {
          tabs: [
            {
              use: 'ChildPageTabModel',
              subModels: {
                grid: grid([formOptions(spec, fields, renderField, mode, true)]),
              },
            },
          ],
        },
      },
    },
  };
}

export function createNativeBlockOptions(
  spec: BlockSpec,
  renderField: FieldRenderer,
  hasChart: (name: string) => boolean,
  includeActions = true,
  currentRecord?: { dataSourceKey?: string; collectionName?: string; filterByTk?: unknown },
): CreateModelOptions {
  if (spec.blockType === 'chart') {
    if (!spec.charts?.length) throw new Error('No compatible chart configuration');
    return grid(spec.charts.map((chart) => chartOptions(chart, spec, hasChart)));
  }
  const fields = [...new Set(spec.blockType === 'table' ? spec.table?.fields : spec.form?.fields)];
  if (!fields.length) throw new Error('No compatible field renderer');
  if (spec.blockType === 'form') {
    const options = formOptions(
      spec,
      fields,
      renderField,
      spec.form?.mode === 'create' ? 'create' : 'edit',
      includeActions,
    );
    const hasCurrentRecord =
      currentRecord?.collectionName === spec.primaryCollection &&
      (currentRecord.dataSourceKey || 'main') === spec.dataSource &&
      currentRecord.filterByTk != null;
    // Matching popups use their record anchor; standalone blocks retain native pagination.
    return grid([
      spec.form?.mode === 'create' || hasCurrentRecord
        ? options
        : {
            ...options,
            stepParams: { ...options.stepParams, resourceSettings: { init: binding(spec) } },
          },
    ]);
  }
  const actions = includeActions ? spec.table?.actions || [] : [];
  const rowActions: CreateModelOptions[] = [];
  if (actions.includes('view')) rowActions.push(popupAction(spec, fields, renderField, 'details'));
  if (actions.includes('edit')) rowActions.push(popupAction(spec, fields, renderField, 'edit'));
  if (actions.includes('delete')) rowActions.push({ use: 'DeleteActionModel' });
  return grid([
    {
      use: 'TableBlockModel',
      stepParams: { ...title(spec.title), resourceSettings: { init: binding(spec) } },
      subModels: {
        columns: [
          ...fields.map(
            (field): CreateModelOptions => ({
              use: 'TableColumnModel',
              stepParams: {
                fieldSettings: { init: { ...binding(spec), fieldPath: field } },
                tableColumnSettings: { sorter: { sorter: !!spec.table?.sortable?.includes(field) } },
              },
              subModels: { field: renderField(field, 'display') },
            }),
          ),
          ...(rowActions.length ? [{ use: 'TableActionsColumnModel', subModels: { actions: rowActions } }] : []),
        ],
        actions: actions.includes('add') ? [popupAction(spec, fields, renderField, 'create')] : [],
      },
    },
  ]);
}
