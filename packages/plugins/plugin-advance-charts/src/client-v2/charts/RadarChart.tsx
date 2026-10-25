/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';

import { Chart, ChartType, RenderProps } from '@nocobase/plugin-data-visualization/client-v2';
import { Card, Spin } from 'antd';

import { tExpr } from '../locale';
import { fieldConfig, getDimensionField, getMeasureField, inputConfig, selectConfig, usePlotComponent } from './utils';

type RadarChartProps = {
  title?: string;
  config: Record<string, unknown>;
};

const RadarChartComponent: React.FC<RadarChartProps> = ({ title, config }) => {
  const Radar = usePlotComponent<Record<string, unknown>>('Radar');
  return (
    <Card size="small" bordered={false} styles={{ body: { padding: 0 } }}>
      <div style={{ height: 320 }}>{Radar ? <Radar {...config} height={320} autoFit /> : <Spin />}</div>
    </Card>
  );
};

const COORDINATE_OPTIONS = [
  { label: 'Radial', value: 'radar' },
  { label: 'Polar', value: 'polar' },
];

export class RadarChart extends Chart {
  constructor() {
    super({
      name: 'radar',
      title: tExpr('Radar'),
      Component: RadarChartComponent,
      enableAdvancedConfig: true,
      config: [
        fieldConfig('xField', 'Category field'),
        fieldConfig('yField', 'Value field'),
        inputConfig('title', 'Title'),
        selectConfig('coordinateType', 'Coordinate', COORDINATE_OPTIONS, 'radar'),
      ],
    });
  }

  init: ChartType['init'] = (fields, { measures, dimensions }) => ({
    general: {
      xField: getDimensionField(fields, dimensions),
      yField: getMeasureField(fields, measures),
      title: '',
      coordinateType: 'radar',
    },
  });

  getProps({ data, general, fieldProps }: RenderProps) {
    const rows = data.map((row) => ({
      category: String(row[general?.xField] ?? ''),
      value: Number(row[general?.yField]) || 0,
    }));
    return {
      ...general,
      title: general?.title || fieldProps[general?.yField]?.label || general?.yField,
      config: {
        data: rows,
        xField: 'category',
        yField: 'value',
        coordinateType: general?.coordinateType || 'radar',
        shape: 'smooth',
        style: { lineWidth: 2 },
        scale: { y: { nice: true } },
        legend: false,
        tooltip: { title: (d: { category: string }) => d.category },
      },
    };
  }
}
