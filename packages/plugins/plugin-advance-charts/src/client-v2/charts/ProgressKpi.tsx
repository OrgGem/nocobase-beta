import React from 'react';

import { Chart, ChartType, RenderProps } from '@nocobase/plugin-data-visualization/client-v2';
import { Card, Progress, Space, Typography } from 'antd';

import { tExpr } from '../locale';
import {
  booleanConfig,
  fieldConfig,
  fieldLabel,
  getMeasureField,
  inputConfig,
  numberConfig,
  selectConfig,
  toNumber,
} from './utils';

const { Text } = Typography;

type ProgressKpiProps = {
  title?: string;
  percent: number;
  value?: number;
  target?: number;
  showTarget?: boolean;
  type?: 'line' | 'circle' | 'dashboard';
  status?: 'success' | 'exception' | 'active' | 'normal';
  strokeColor?: string;
  showInfo?: boolean;
};

const ProgressKpiComponent: React.FC<ProgressKpiProps> = ({
  title,
  percent,
  value,
  target,
  showTarget = false,
  type = 'line',
  status,
  strokeColor,
  showInfo = true,
}) => (
  <Card size="small" bordered={false} styles={{ body: { padding: 0 } }}>
    {title ? <Text type="secondary">{title}</Text> : null}
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Progress
        type={type}
        percent={percent}
        status={status || undefined}
        strokeColor={strokeColor || undefined}
        showInfo={showInfo}
      />
      {showTarget ? (
        <Text type="secondary">
          {value} / {target}
        </Text>
      ) : null}
    </Space>
  </Card>
);

export class ProgressKpi extends Chart {
  constructor() {
    super({
      name: 'progress-kpi',
      title: tExpr('Progress KPI Card'),
      Component: ProgressKpiComponent,
      enableAdvancedConfig: true,
      config: [
        fieldConfig('valueField', 'Value field'),
        fieldConfig('targetField', 'Target field', false),
        inputConfig('title', 'Title'),
        numberConfig('maxValue', 'Max value', 100),
        selectConfig(
          'type',
          'Progress type',
          [
            { label: 'Line', value: 'line' },
            { label: 'Circle', value: 'circle' },
            { label: 'Dashboard', value: 'dashboard' },
          ],
          'line',
        ),
        selectConfig(
          'status',
          'Status',
          [
            { label: 'Normal', value: '' },
            { label: 'Success', value: 'success' },
            { label: 'Exception', value: 'exception' },
            { label: 'Active', value: 'active' },
          ],
          '',
        ),
        inputConfig('strokeColor', 'Color'),
        booleanConfig('showInfo', 'Show value', true),
      ],
    });
  }

  init: ChartType['init'] = (fields, { measures }) => {
    const valueField = getMeasureField(fields, measures);
    return {
      general: {
        valueField,
        title: fieldLabel({}, valueField),
        maxValue: 100,
        type: 'line',
        showInfo: true,
      },
    };
  };

  getProps({ data, general, fieldProps }: RenderProps) {
    const row = data[0] || {};
    const value = toNumber(row[general?.valueField]);
    const target = general?.targetField ? toNumber(row[general.targetField]) : toNumber(general?.maxValue, 100);
    const percent = target > 0 ? Math.min(100, Math.max(0, Number(((value / target) * 100).toFixed(2)))) : 0;
    return {
      ...general,
      title: general?.title || fieldLabel(fieldProps, general?.valueField),
      value,
      target,
      showTarget: Boolean(general?.targetField),
      percent,
    };
  }
}
