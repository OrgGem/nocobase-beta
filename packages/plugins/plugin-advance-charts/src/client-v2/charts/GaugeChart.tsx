import React from 'react';

import { Chart, ChartType, RenderProps } from '@nocobase/plugin-data-visualization/client-v2';
import { Card, Spin, Typography } from 'antd';

import { tExpr } from '../locale';
import { fieldConfig, getMeasureField, inputConfig, numberConfig, toNumber, usePlotComponent } from './utils';

const { Text } = Typography;

type GaugeChartProps = {
  title?: string;
  config: Record<string, unknown>;
  displayValue: number;
};

const GaugeChartComponent: React.FC<GaugeChartProps> = ({ title, config, displayValue }) => {
  const Gauge = usePlotComponent<Record<string, unknown>>('Gauge');
  return (
    <Card size="small" bordered={false} styles={{ body: { padding: 0 } }}>
      {title ? <Text type="secondary">{title}</Text> : null}
      <div style={{ height: 220 }}>{Gauge ? <Gauge key={displayValue} {...config} height={220} /> : <Spin />}</div>
    </Card>
  );
};

export class GaugeChart extends Chart {
  constructor() {
    super({
      name: 'gauge',
      title: tExpr('Gauge'),
      Component: GaugeChartComponent,
      enableAdvancedConfig: true,
      config: [
        fieldConfig('valueField', 'Value field'),
        inputConfig('title', 'Title'),
        numberConfig('maxValue', 'Max value', 100),
        inputConfig('color', 'Color'),
      ],
    });
  }

  init: ChartType['init'] = (fields, { measures }) => {
    const valueField = getMeasureField(fields, measures);
    return {
      general: {
        valueField,
        title: valueField,
        maxValue: 100,
      },
    };
  };

  getProps({ data, general, fieldProps }: RenderProps) {
    const row = data[0] || {};
    const value = toNumber(row[general?.valueField]);
    const maxValue = toNumber(general?.maxValue, 100);
    const percent = maxValue > 0 ? Math.min(1, Math.max(0, value / maxValue)) : 0;
    return {
      ...general,
      title: general?.title || fieldProps[general?.valueField]?.label || general?.valueField,
      displayValue: value,
      config: {
        percent,
        displayValue: value,
        range: general?.color
          ? {
              color: general.color,
            }
          : undefined,
        indicator: {
          pointer: {
            style: {
              stroke: general?.color,
            },
          },
        },
        statistic: {
          content: {
            formatter: () => String(value),
          },
        },
      },
    };
  }
}
