import { uid } from '@formily/shared';

import type { VisualizationChartTemplate, VisualizationTemplate } from './registry';

export type VisualizationTemplateMapping = Record<string, string | undefined>;

export type CreateVisualizationTemplateSchemaOptions = {
  dataSource: string;
  collection: string;
  template: VisualizationTemplate;
  mapping: VisualizationTemplateMapping;
};

const resolveRole = (role: string, mapping: VisualizationTemplateMapping) => mapping?.[role];

const canCreateChart = (chart: VisualizationChartTemplate, mapping: VisualizationTemplateMapping) => {
  const roles = [
    ...(chart.measures || []).map((item) => item.role),
    ...(chart.dimensions || []).map((item) => item.role),
  ];
  return roles.every((role) => Boolean(resolveRole(role, mapping)));
};

const createRendererSchema = (decoratorProps: any, componentProps: any = {}) => {
  const { collection, config } = decoratorProps;
  const { title, bordered } = config || {};
  return {
    type: 'void',
    'x-decorator': 'ChartRendererProvider',
    'x-decorator-props': decoratorProps,
    'x-acl-action': `${collection}:list`,
    'x-toolbar': 'ChartRendererToolbar',
    'x-settings': 'chart:renderer',
    'x-component': 'CardItem',
    'x-component-props': {
      size: 'small',
      title,
      bordered,
    },
    'x-initializer': 'charts:addBlock',
    properties: {
      actions: {
        type: 'void',
        'x-decorator': 'div',
        'x-decorator-props': {
          style: {
            position: 'absolute',
            top: 0,
            right: 0,
            zIndex: 10,
          },
        },
        'x-component': 'ActionBar',
        'x-component-props': {
          style: {
            marginRight: 'var(--nb-designer-offset)',
            marginTop: 'var(--nb-designer-offset)',
          },
        },
        'x-initializer': 'chart:configureActions',
      },
      [uid()]: {
        type: 'void',
        'x-component': 'ChartRenderer',
        'x-component-props': componentProps,
      },
    },
  };
};

const gridRowColWrap = (schema: any) => ({
  type: 'void',
  'x-component': 'Grid.Row',
  properties: {
    [uid()]: {
      type: 'void',
      'x-component': 'Grid.Col',
      properties: {
        [schema?.name || uid()]: schema,
      },
    },
  },
});

const createChartSchema = (
  chart: VisualizationChartTemplate,
  options: Omit<CreateVisualizationTemplateSchemaOptions, 'template'>,
) => {
  const dimensions = (chart.dimensions || []).map((dimension) => ({
    field: resolveRole(dimension.role, options.mapping),
    alias: dimension.alias || dimension.role,
    format: dimension.format,
  }));
  const measures = (chart.measures || []).map((measure) => ({
    field: resolveRole(measure.role, options.mapping),
    aggregation: measure.aggregation || 'count',
    alias: measure.alias,
    distinct: measure.distinct,
  }));

  const config = {
    chartType: chart.chartType,
    title: chart.title,
    bordered: false,
    general: chart.config || {},
    advanced: chart.advanced || {},
  };

  const rendererProps = {
    mode: 'builder',
    dataSource: options.dataSource,
    collection: options.collection,
    query: {
      measures,
      dimensions,
      limit: chart.advanced?.limit ?? 2000,
      offset: 0,
    },
    config,
    transform: chart.transform,
  };

  return gridRowColWrap(createRendererSchema(rendererProps));
};

export const createVisualizationTemplateSchema = (options: CreateVisualizationTemplateSchemaOptions) => {
  const chartSchemas = options.template.charts
    .filter((chart) => canCreateChart(chart, options.mapping))
    .map((chart) =>
      createChartSchema(chart, {
        dataSource: options.dataSource,
        collection: options.collection,
        mapping: options.mapping,
      }),
    );

  const properties: Record<string, any> = {};
  chartSchemas.forEach((schema) => {
    properties[uid()] = schema;
  });

  return {
    type: 'void',
    'x-component': 'ChartCardItem',
    'x-use-component-props': 'useChartBlockCardProps',
    'x-settings': 'chart:block',
    'x-decorator': 'ChartBlockProvider',
    properties: {
      actions: {
        type: 'void',
        'x-component': 'ActionBar',
        'x-component-props': {
          style: {
            marginBottom: 'var(--nb-designer-offset)',
          },
        },
        'x-initializer': 'chartBlock:configureActions',
      },
      [uid()]: {
        type: 'void',
        'x-component': 'Grid',
        'x-decorator': 'ChartV2Block',
        'x-initializer': 'charts:addBlock',
        properties,
      },
    },
  };
};

export const normalizeFieldName = (name = '') => name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

export const inferFieldMapping = (roles: any[], fields: any[]) => {
  const mapping: VisualizationTemplateMapping = {};
  for (const role of roles) {
    const matchNames = (role.matchNames || []).map(normalizeFieldName);
    const hasMatchNames = matchNames.length > 0;
    const hasTypeConstraints = Boolean(role.fieldTypes?.length || role.interfaces?.length);
    const field = fields.find((item) => {
      const normalizedName = normalizeFieldName(item.name);
      const typeMatched = !role.fieldTypes?.length || role.fieldTypes.includes(item.type);
      const interfaceMatched = !role.interfaces?.length || role.interfaces.includes(item.interface);
      if (hasMatchNames) {
        // When matchNames are specified, match by name first, then validate type/interface
        return matchNames.includes(normalizedName) && typeMatched && interfaceMatched;
      }
      if (hasTypeConstraints) {
        // When only type/interface constraints exist, match purely by type
        return typeMatched && interfaceMatched;
      }
      // No constraints at all — skip auto-matching for this role
      return false;
    });
    if (field) {
      mapping[role.name] = field.name;
    }
  }
  if (!mapping.record && fields[0]?.name) {
    mapping.record = fields.find((field) => field.name === 'id')?.name || fields[0].name;
  }
  return mapping;
};
