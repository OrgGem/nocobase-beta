import { DEFAULT_DATA_SOURCE_KEY } from '@nocobase/client-v2';
import { tExpr, useFlowContext } from '@nocobase/flow-engine';
import type { FlowModel } from '@nocobase/flow-engine';
import { Button, Empty, Space, Spin } from 'antd';
import dayjs from 'dayjs';
import React from 'react';

import { ConfigPanel } from './ConfigPanelCompat';
import { getDataVisualizationPlugin } from './dataVisualizationPlugin';

// NOTE: These deep imports are essential to the compat layer — they integrate with the
// upstream plugin's internal chart-configuration system (builder service, dataset utils).
// There is no public API for these symbols; changes upstream may require updates here.
import { genRawByBuilder } from '@nocobase/plugin-data-visualization/src/client-v2/flow/models/ChartOptionsBuilder.service';
import {
  convertDatasetFormats,
  normalizeEChartsOption,
} from '@nocobase/plugin-data-visualization/src/client-v2/flow/utils';
import { useDataVisualizationT } from './utils';

type QueryItem = {
  field?: string | string[];
  alias?: string;
  aggregation?: string;
  format?: string;
};

type QueryPayload = {
  collectionPath?: string[];
  dimensions?: QueryItem[];
  measures?: QueryItem[];
};

type ChartPayload = {
  mode: 'basic' | 'custom';
  builder?: Record<string, unknown>;
  raw?: string;
  query?: QueryPayload;
};

type FieldProps = Record<
  string,
  {
    label?: string;
    interface?: string;
    transformer?: (value: unknown) => unknown;
  }
>;

type ChartBlockModelCompat = FlowModel & {
  applyQuery(query: unknown): void | Promise<void>;
  applyEvents(raw?: string): void | Promise<void>;
  buildQueryRequest(query: unknown): Promise<unknown>;
  cancelPreview(): void | Promise<void>;
  context: FlowModel['context'] & {
    chartRef?: React.RefObject<unknown>;
    collection?: {
      getField?: (name: string) => unknown;
    };
    dataSourceManager?: {
      getCollection?: (dataSourceKey: string, collectionName: string) => unknown;
    };
    runjs?: (raw?: string) => Promise<{ success?: boolean; value?: unknown; error?: unknown }>;
  };
  props: {
    chart?: Record<string, unknown>;
  };
  resource?: {
    getData?: () => unknown;
    loading?: boolean;
  };
  decoratorProps?: {
    heightMode?: string;
  };
  onPreview(params: unknown, needQueryData?: boolean): Promise<void>;
  __advancedChartsNoPreviewSnapshot?: unknown;
  __advancedChartsOriginalOnPreview?: (params: unknown, needQueryData?: boolean) => Promise<void>;
};

const toFieldPath = (field: string | string[] | undefined) => {
  if (!field) return '';
  return Array.isArray(field) ? field.filter(Boolean).join('.') : field;
};

const toFieldSegments = (field: string | string[] | undefined) => {
  if (!field) return [];
  return Array.isArray(field) ? field.filter(Boolean) : field.split('.').filter(Boolean);
};

const getCollectionFieldLabel = (field?: {
  uiSchema?: { title?: string };
  options?: { uiSchema?: { title?: string } };
  title?: string;
  name?: string;
}) => {
  return field?.uiSchema?.title ?? field?.options?.uiSchema?.title ?? field?.title ?? field?.name;
};

const createDateFormatTransformer = (format?: string) => {
  if (!format) return;
  return (value: unknown) => {
    if (value === null || value === undefined || value === '') {
      return value;
    }
    const date = dayjs(value as string);
    return date.isValid() ? date.format(format) : value;
  };
};

const composeTransformers = (...transformers: (((value: unknown) => unknown) | undefined)[]) => {
  const validTransformers = transformers.filter(Boolean) as ((value: unknown) => unknown)[];
  if (!validTransformers.length) return;
  return (value: unknown) => validTransformers.reduce((result, transformer) => transformer(result), value);
};

const ChartComponentHost = ({
  Component,
  option,
  dataSource,
  loading,
}: {
  Component?: React.FC<Record<string, unknown>>;
  option?: Record<string, unknown>;
  dataSource?: unknown;
  loading?: boolean;
}) => {
  const t = useDataVisualizationT();

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', width: '100%', height: 400 }}>
        <Spin />
      </div>
    );
  }

  if (!option || !dataSource) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('Please configure chart')} />;
  }

  return Component ? <Component {...option} /> : null;
};

const PreviewButton = () => {
  const t = useDataVisualizationT();
  const ctx = useFlowContext();
  return (
    <Button
      color="primary"
      variant="outlined"
      onClick={async () => {
        const formValues = ctx.getStepFormValues('chartSettings', 'configure');
        await ctx.model.onPreview(formValues, true);
      }}
    >
      {t('Preview')}
    </Button>
  );
};

const CancelButton = () => {
  const t = useDataVisualizationT();
  const ctx = useFlowContext();
  return (
    <Button
      type="default"
      onClick={() => {
        ctx.model.cancelPreview();
        ctx.view.close();
      }}
    >
      {t('Cancel')}
    </Button>
  );
};

function getRegisteredChart(this: ChartBlockModelCompat, type?: string) {
  if (!type) return;
  return getDataVisualizationPlugin(this.context.app)?.charts?.getChart?.(type);
}

function getRegisteredChartGeneral(builder: Record<string, unknown> = {}) {
  const { type, advanced, ...general } = builder;
  return general;
}

function getCollectionFieldByPath(
  this: ChartBlockModelCompat,
  query: QueryPayload,
  field: string | string[] | undefined,
) {
  const fieldSegments = toFieldSegments(field);
  if (!fieldSegments.length) return;

  const [dataSourceKey = DEFAULT_DATA_SOURCE_KEY, collectionName] = query?.collectionPath || [];
  let collection = collectionName
    ? (this.context.dataSourceManager?.getCollection?.(dataSourceKey, collectionName) as
        | { getField?: (name: string) => unknown }
        | undefined)
    : this.context.collection;

  let collectionField: { targetCollection?: typeof collection } | undefined;
  for (const [index, fieldName] of fieldSegments.entries()) {
    collectionField = collection?.getField?.(fieldName) as typeof collectionField;
    if (!collectionField) return;
    if (index < fieldSegments.length - 1) {
      collection = collectionField.targetCollection;
    }
  }
  return collectionField;
}

function getRegisteredChartFieldTransformer(
  this: ChartBlockModelCompat,
  field?: { interface?: string },
  item?: QueryItem,
) {
  if (!field) return createDateFormatTransformer(item?.format);
  const plugin = getDataVisualizationPlugin(this.context.app);
  const formatter = item?.aggregation
    ? undefined
    : plugin?.fieldInterfaceConfigs?.[field.interface || '']?.valueFormatter;
  return composeTransformers(
    formatter ? (value: unknown) => formatter(field, value, this.context) : undefined,
    createDateFormatTransformer(item?.format),
  );
}

function getRegisteredChartFieldProps(
  this: ChartBlockModelCompat,
  query: QueryPayload = {},
  data: Record<string, unknown>[] = [],
) {
  const fieldProps: FieldProps = {};
  const addField = (name: string, label?: string, field?: { interface?: string }, item?: QueryItem) => {
    if (!name || fieldProps[name]) return;
    fieldProps[name] = {
      label: label || getCollectionFieldLabel(field) || name,
      interface: field?.interface,
      transformer: getRegisteredChartFieldTransformer.call(this, field, item),
    };
  };

  (query?.dimensions || []).forEach((item) => {
    const name = item?.alias || toFieldPath(item?.field);
    const collectionField = getCollectionFieldByPath.call(this, query, item?.field) as { interface?: string };
    addField(name, item?.alias || getCollectionFieldLabel(collectionField), collectionField, item);
  });

  (query?.measures || []).forEach((item) => {
    const name = item?.alias || toFieldPath(item?.field);
    const collectionField = getCollectionFieldByPath.call(this, query, item?.field) as { interface?: string };
    addField(name, item?.alias || getCollectionFieldLabel(collectionField), collectionField, item);
  });

  Object.keys(data[0] || {}).forEach((name) => addField(name));

  return fieldProps;
}

function formatRegisteredChartData(data: Record<string, unknown>[] = [], fieldProps: FieldProps = {}) {
  return data.map((row) => {
    const next = { ...row };
    Object.entries(fieldProps).forEach(([key, props]) => {
      if (props?.transformer && Object.prototype.hasOwnProperty.call(next, key)) {
        next[key] = props.transformer(next[key]);
      }
    });
    return next;
  });
}

function getRegisteredChartDisplayFieldProps(fieldProps: FieldProps = {}) {
  return Object.entries(fieldProps).reduce<Record<string, Omit<FieldProps[string], 'transformer'>>>(
    (result, [key, props]) => {
      const { transformer, ...displayProps } = props || {};
      result[key] = displayProps;
      return result;
    },
    {},
  );
}

async function applyChartOptions(this: ChartBlockModelCompat, payload: ChartPayload) {
  if (payload.mode === 'basic') {
    const chart = getRegisteredChart.call(this, payload.builder?.type as string | undefined);
    if (chart) {
      const rawData = (convertDatasetFormats(this.resource?.getData?.())?.objects || []) as Record<string, unknown>[];
      const fieldProps = getRegisteredChartFieldProps.call(this, payload.query, rawData);
      const data = formatRegisteredChartData(rawData, fieldProps);
      const option = chart.getProps({
        data,
        general: getRegisteredChartGeneral(payload.builder),
        advanced: payload.builder?.advanced || {},
        fieldProps: getRegisteredChartDisplayFieldProps(fieldProps),
      });

      normalizeEChartsOption(option);

      this.setProps({
        chart: {
          ...this.props.chart,
          Component: chart.Component,
          option,
        },
      });
      return;
    }
  }

  const optionRaw = payload.mode === 'basic' ? genRawByBuilder(payload.builder) : payload.raw;
  const result = await this.context.runjs?.(optionRaw);
  if (!result?.success && result?.error) {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
      console.error('applyChartOptions runjs error:', result.error);
    }
    return;
  }

  normalizeEChartsOption(result?.value);

  this.setProps({
    chart: {
      ...this.props.chart,
      Component: undefined,
      optionRaw,
      option: result?.value,
    },
  });
}

function renderComponent(this: ChartBlockModelCompat) {
  const chart = this.props.chart || {};
  const Component = chart.Component as React.FC<Record<string, unknown>> | undefined;
  if (!Component) {
    return this.__advancedChartsOriginalRenderComponent?.();
  }

  return (
    <ChartComponentHost
      Component={Component}
      option={chart.option as Record<string, unknown>}
      dataSource={this.resource?.getData?.()}
      loading={this.resource?.loading}
    />
  );
}

async function onPreview(this: ChartBlockModelCompat, params: unknown, needQueryData?: boolean) {
  if (!Object.prototype.hasOwnProperty.call(this, '__advancedChartsNoPreviewSnapshot')) {
    this.__advancedChartsNoPreviewSnapshot = (this as unknown as { _previousStepParams?: unknown })._previousStepParams;
  }
  await this.__advancedChartsOriginalOnPreview?.(params, needQueryData);
}

export async function patchDataVisualizationChartBlock(flowEngine: {
  getModelClassAsync(name: string): Promise<unknown>;
}) {
  const ChartBlockModel = (await flowEngine.getModelClassAsync('ChartBlockModel')) as
    | (typeof FlowModel & { prototype: ChartBlockModelCompat['prototype'] })
    | undefined;

  if (!ChartBlockModel || ChartBlockModel.prototype.__advancedChartsPatched) {
    return;
  }

  ChartBlockModel.prototype.__advancedChartsPatched = true;
  ChartBlockModel.prototype.__advancedChartsOriginalRenderComponent = ChartBlockModel.prototype.renderComponent;
  ChartBlockModel.prototype.__advancedChartsOriginalOnPreview = ChartBlockModel.prototype.onPreview;
  ChartBlockModel.prototype.onPreview = onPreview;
  ChartBlockModel.prototype.renderComponent = renderComponent;
  ChartBlockModel.prototype.applyChartOptions = applyChartOptions;

  ChartBlockModel.registerFlow({
    key: 'chartSettings',
    title: tExpr('Chart settings', { ns: 'data-visualization' }),
    steps: {
      configure: {
        title: tExpr('Configure chart', { ns: 'data-visualization' }),
        uiMode: {
          type: 'embed',
          props: {
            footer: (_originNode: React.ReactNode, { OkBtn }: { OkBtn: React.FC }) => (
              <Space>
                <CancelButton />
                <PreviewButton />
                <OkBtn />
              </Space>
            ),
          },
        },
        uiSchema: {
          configuration: {
            type: 'void',
            'x-component': ConfigPanel,
          },
        },
        async beforeParamsSave(
          ctx: { sql?: { save: (params: unknown) => Promise<unknown> }; model: ChartBlockModelCompat },
          params: { query?: { mode?: string; sql?: string; sqlDatasource?: string } },
        ) {
          const mode = params.query?.mode || 'builder';
          if (mode === 'sql') {
            return ctx.sql?.save({
              uid: ctx.model.uid,
              sql: params.query?.sql,
              dataSourceKey: params.query?.sqlDatasource,
            });
          }
        },
        async afterParamsSave(ctx: { model: Record<string, unknown> }) {
          ctx.model._previousStepParams = ctx.model.__advancedChartsNoPreviewSnapshot;
        },
        defaultParams() {
          return {
            query: {
              mode: 'builder',
            },
            chart: {
              option: {
                mode: 'basic',
              },
            },
          };
        },
        useRawParams: true,
        async handler(
          ctx: { model: ChartBlockModelCompat },
          params: {
            query?: unknown;
            chart?: {
              option?: { mode?: 'basic' | 'custom'; builder?: Record<string, unknown>; raw?: string };
              events?: { raw?: string };
            };
          },
        ) {
          const { query, chart } = params;
          if (!query || !chart) {
            return;
          }

          try {
            ctx.model.applyQuery(await ctx.model.buildQueryRequest(query));
            await ctx.model.applyChartOptions({
              mode: chart.option?.mode || 'basic',
              builder: chart.option?.builder,
              raw: chart.option?.raw,
              query: query as QueryPayload,
            });

            if (chart.events?.raw) {
              await ctx.model.applyEvents(chart.events?.raw);
            }
          } catch (error) {
            if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
              console.error('ChartBlockModel chartSettings configure flow handler() error:', error);
            }
          }
        },
      },
    },
  });
}

declare module '@nocobase/flow-engine' {
  interface FlowModel {
    __advancedChartsPatched?: boolean;
    __advancedChartsOriginalRenderComponent?: () => React.ReactNode;
    applyChartOptions?: (payload: ChartPayload) => Promise<void>;
  }
}
