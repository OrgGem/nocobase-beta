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
import { Card, Progress, Space, Typography } from 'antd';

import { tExpr } from '../locale';
import {
  booleanConfig,
  fieldConfig,
  fieldLabel,
  formatNumber,
  getMeasureField,
  inputConfig,
  isValidPlotColor,
  numberConfig,
  selectConfig,
  toNumber,
} from './utils';

const { Text } = Typography;

type ProgressStatus = 'success' | 'exception' | 'active' | 'normal';

type ProgressKpiProps = {
  title?: string;
  percent: number;
  value?: number;
  target?: number;
  showTarget?: boolean;
  type?: 'line' | 'circle' | 'dashboard';
  status?: ProgressStatus;
  strokeColor?: string;
  showInfo?: boolean;
};

const DEFAULT_TARGET = 100;

const resolveStatus = (status: ProgressStatus | undefined, percent: number): ProgressStatus | undefined => {
  if (status) return status;
  if (percent >= 100) return 'success';
  if (percent >= 50) return 'active';
  return undefined;
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
        status={resolveStatus(status, percent)}
        strokeColor={strokeColor || undefined}
        showInfo={showInfo}
      />
      {showTarget ? (
        <Text type="secondary">
          {formatNumber(value)} / {formatNumber(target)}
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
        numberConfig('maxValue', 'Max value', DEFAULT_TARGET),
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
        title: '',
        maxValue: DEFAULT_TARGET,
        type: 'line',
        showInfo: true,
      },
    };
  };

  getProps({ data, general, fieldProps }: RenderProps) {
    const row = data[0] || {};
    const value = toNumber(row[general?.valueField]);
    const target = general?.targetField
      ? toNumber(row[general.targetField])
      : toNumber(general?.maxValue, DEFAULT_TARGET);
    const percent = target > 0 ? Math.min(100, Math.max(0, Number(((value / target) * 100).toFixed(2)))) : 0;
    const strokeColor = isValidPlotColor(general?.strokeColor) ? general.strokeColor.trim() : undefined;
    return {
      ...general,
      title: general?.title || fieldLabel(fieldProps, general?.valueField),
      value,
      target,
      strokeColor,
      showTarget: Boolean(general?.targetField),
      percent,
    };
  }
}
