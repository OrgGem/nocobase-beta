import React from 'react';

import { Chart, ChartType, RenderProps } from '@nocobase/plugin-data-visualization/client-v2';
import { Card, Spin, Typography } from 'antd';

import { tExpr } from '../locale';
import {
  fieldConfig,
  getDimensionField,
  getMeasureField,
  inputConfig,
  selectConfig,
  toNumber,
  usePlotComponent,
} from './utils';

const { Text } = Typography;

type HeatmapChartProps = {
  title?: string;
  config: Record<string, unknown>;
};

const HeatmapChartComponent: React.FC<HeatmapChartProps> = ({ title, config }) => {
  const Heatmap = usePlotComponent<Record<string, unknown>>('Heatmap');
  return (
    <Card size="small" bordered={false} styles={{ body: { padding: 0 } }}>
      {title ? <Text type="secondary">{title}</Text> : null}
      <div style={{ height: 280, marginTop: 8 }}>
        {Heatmap ? <Heatmap {...config} height={280} autoFit /> : <Spin />}
      </div>
    </Card>
  );
};

const SHAPE_OPTIONS = [
  { label: 'Square', value: 'point' },
  { label: 'Circle', value: 'circle' },
];

// Heatmap is not part of the built-in chart types (which stop at pie/funnel/scatter), so it fills
// the gap left when a query has two categorical dimensions instead of a single series.
export class HeatmapChart extends Chart {
  constructor() {
    super({
      name: 'heatmap',
      title: tExpr('Heatmap'),
      Component: HeatmapChartComponent,
      enableAdvancedConfig: true,
      config: [
        fieldConfig('xField', 'Category field'),
        fieldConfig('yField', 'Row field'),
        fieldConfig('valueField', 'Value field'),
        inputConfig('title', 'Title'),
        selectConfig('shape', 'Shape', SHAPE_OPTIONS, 'point'),
      ],
    });
  }

  init: ChartType['init'] = (fields, { dimensions, measures }) => ({
    general: {
      xField: getDimensionField(fields, dimensions),
      yField: fields[1]?.value || fields[0]?.value,
      valueField: getMeasureField(fields, measures),
      title: '',
      shape: 'point',
    },
  });

  getProps({ data, general, fieldProps }: RenderProps) {
    const xField = general?.xField;
    const yField = general?.yField;
    const valueField = general?.valueField;
    const rows = data.map((row) => ({
      x: String(row[xField] ?? ''),
      y: String(row[yField] ?? ''),
      value: toNumber(row[valueField]),
    }));
    const colorRange =
      general?.colorRange && typeof general.colorRange === 'string' && general.colorRange.trim()
        ? general.colorRange
            .split(',')
            .map((color: string) => color.trim())
            .filter(Boolean)
        : undefined;
    return {
      ...general,
      title: general?.title || fieldProps[valueField]?.label || valueField,
      config: {
        data: rows,
        xField: 'x',
        yField: 'y',
        colorField: 'value',
        shape: general?.shape || 'point',
        scale: { color: colorRange ? { range: colorRange } : undefined },
        legend: true,
        tooltip: true,
        axis: { x: { title: false }, y: { title: false } },
      },
    };
  }
}
