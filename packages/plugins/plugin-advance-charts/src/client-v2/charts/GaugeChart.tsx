import React from 'react';

import { Chart, ChartType, RenderProps } from '@nocobase/plugin-data-visualization/client-v2';
import { Card, Spin, Typography } from 'antd';

import { tExpr } from '../locale';
import {
  fieldConfig,
  formatNumber,
  getMeasureField,
  inputConfig,
  numberConfig,
  resolvePlotColor,
  toNumber,
  usePlotComponent,
} from './utils';

const { Text } = Typography;
const GAUGE_ARC_COLORS = ['#30bf78', '#faad14', '#f5222d'];
const GAUGE_MIN_COLOR = GAUGE_ARC_COLORS[0];

type GaugeChartProps = {
  title?: string;
  config: Record<string, unknown>;
  percent: number;
  displayValue: number;
  unit: string;
};

// The gauge center text is a single localized unit string; "value (percent)" reads well in both en
// and zh without pulling in plural/gender rules.
const buildCenterText = (percent: number) => `${Math.round(percent * 1000) / 10}%`;

const GaugeChartComponent: React.FC<GaugeChartProps> = ({ title, config, percent, displayValue, unit }) => {
  const Gauge = usePlotComponent<Record<string, unknown>>('Gauge');
  const gauge = Gauge ? <Gauge key={percent} {...config} height={220} /> : <Spin />;
  return (
    <Card size="small" bordered={false} styles={{ body: { padding: 0 } }}>
      {title ? <Text type="secondary">{title}</Text> : null}
      <div style={{ height: 220, marginTop: 8 }}>{gauge}</div>
      <Text style={{ fontSize: 18, fontWeight: 600, display: 'block', textAlign: 'center' }}>
        {formatNumber(displayValue)}
        {unit} ({buildCenterText(percent)})
      </Text>
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
        inputConfig('unit', 'Unit'),
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
        unit: '',
        maxValue: 100,
      },
    };
  };

  getProps({ data, general, fieldProps }: RenderProps) {
    const row = data[0] || {};
    const value = toNumber(row[general?.valueField]);
    const maxValue = toNumber(general?.maxValue, 100);
    const percent = maxValue > 0 ? Math.min(1, Math.max(0, value / maxValue)) : 0;
    const color = resolvePlotColor(general?.color, GAUGE_MIN_COLOR);
    return {
      ...general,
      title: general?.title || fieldProps[general?.valueField]?.label || general?.valueField,
      unit: general?.unit || '',
      // The component renders this value, so keep it raw here and format it once at render time.
      displayValue: value,
      percent,
      config: {
        // plots v2 keeps the percentage in `data`; G2 turns it into the arc + pointer marks.
        data: percent,
        scale: {
          color: {
            range: [color, '#e8e8e8'],
          },
        },
        style: {
          arc: { lineWidth: 22, strokeLinecap: 'round' },
          pointer: { radius: 0.6, stroke: color, lineWidth: 4 },
          pin: { r: 8, fill: color },
          text: { content: buildCenterText(percent), fontSize: 20, fontWeight: 800 },
        },
      },
    };
  }
}
