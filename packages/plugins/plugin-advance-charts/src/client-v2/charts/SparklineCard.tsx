import React from 'react';

import { Chart, ChartType, RenderProps } from '@nocobase/plugin-data-visualization/client-v2';
import { Card, Spin, Statistic } from 'antd';

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

type SparklineCardProps = {
  title?: string;
  value?: number;
  prefix?: string;
  suffix?: string;
  plotType: string;
  plotConfig: Record<string, unknown>;
};

const SparklineCardComponent: React.FC<SparklineCardProps> = ({
  title,
  value,
  prefix,
  suffix,
  plotType,
  plotConfig,
}) => {
  const Component = usePlotComponent<Record<string, unknown>>(plotType);
  return (
    <Card size="small" bordered={false} styles={{ body: { padding: 0 } }}>
      <Statistic title={title} value={value} prefix={prefix} suffix={suffix} />
      <div style={{ height: 72, marginTop: 8 }}>
        {Component ? <Component {...plotConfig} height={72} autoFit /> : <Spin />}
      </div>
    </Card>
  );
};

export class SparklineCard extends Chart {
  constructor() {
    super({
      name: 'sparkline-card',
      title: tExpr('Sparkline Card'),
      Component: SparklineCardComponent,
      config: [
        fieldConfig('xField', 'Date field'),
        fieldConfig('yField', 'Value field'),
        inputConfig('title', 'Title'),
        inputConfig('prefix', 'Prefix'),
        inputConfig('suffix', 'Suffix'),
        selectConfig(
          'shape',
          'Sparkline type',
          [
            { label: 'Line', value: 'Tiny.Line' },
            { label: 'Area', value: 'Tiny.Area' },
            { label: 'Column', value: 'Tiny.Column' },
          ],
          'Tiny.Line',
        ),
        inputConfig('color', 'Color'),
      ],
    });
  }

  init: ChartType['init'] = (fields, { measures, dimensions }) => ({
    general: {
      xField: getDimensionField(fields, dimensions),
      yField: getMeasureField(fields, measures),
      shape: 'Tiny.Line',
    },
  });

  getProps({ data, general, fieldProps }: RenderProps) {
    const xField = general?.xField;
    const yField = general?.yField;
    const sortedData = xField
      ? [...data].sort((a, b) => {
          const left = new Date(String(a[xField] ?? '')).valueOf();
          const right = new Date(String(b[xField] ?? '')).valueOf();
          if (Number.isNaN(left) && Number.isNaN(right)) return 0;
          if (Number.isNaN(left)) return 1;
          if (Number.isNaN(right)) return -1;
          return left - right;
        })
      : data;
    const values = sortedData.map((row) => toNumber(row[yField]));
    return {
      ...general,
      title: general?.title || fieldProps[yField]?.label || yField,
      value: values[values.length - 1] ?? 0,
      plotType: general?.shape || 'Tiny.Line',
      plotConfig: {
        data: values,
        smooth: true,
        color: general?.color,
        annotations: [],
      },
    };
  }
}
