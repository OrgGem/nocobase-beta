import React from 'react';

import { Chart, ChartType, RenderProps } from '@nocobase/plugin-data-visualization/client-v2';
import { Card, Statistic, Typography } from 'antd';

import { tExpr } from '../locale';
import { fieldConfig, fieldLabel, formatNumber, getMeasureField, inputConfig } from './utils';

const { Text } = Typography;

type AdvancedStatisticProps = {
  title?: string;
  value?: unknown;
  prefix?: string;
  suffix?: string;
  precision?: number;
  color?: string;
  link?: string;
  secondaryText?: string;
};

const AdvancedStatisticComponent: React.FC<AdvancedStatisticProps> = ({
  title,
  value,
  prefix,
  suffix,
  precision,
  color,
  link,
  secondaryText,
}) => {
  const content = (
    <Card size="small" bordered={false} styles={{ body: { padding: 0 } }}>
      <Statistic
        title={title}
        value={formatNumber(value, precision)}
        prefix={prefix}
        suffix={suffix}
        valueStyle={color ? { color } : undefined}
      />
      {secondaryText ? <Text type="secondary">{secondaryText}</Text> : null}
    </Card>
  );

  if (!link) {
    return content;
  }

  return (
    <a href={link} target="_blank" rel="noreferrer" style={{ display: 'block' }}>
      {content}
    </a>
  );
};

export class AdvancedStatistic extends Chart {
  constructor() {
    super({
      name: 'advanced-statistic',
      title: tExpr('Advanced Statistic Card'),
      Component: AdvancedStatisticComponent,
      enableAdvancedConfig: true,
      config: [
        fieldConfig('field', 'Metric field'),
        inputConfig('title', 'Title'),
        inputConfig('prefix', 'Prefix'),
        inputConfig('suffix', 'Suffix'),
        inputConfig('color', 'Color'),
        inputConfig('link', 'Link'),
        inputConfig('secondaryText', 'Secondary text'),
        {
          precision: {
            title: tExpr('Precision'),
            type: 'number',
            'x-decorator': 'FormItem',
            'x-component': 'InputNumber',
            default: 0,
            'x-component-props': {
              min: 0,
              max: 8,
            },
          },
        },
      ],
    });
  }

  init: ChartType['init'] = (fields, { measures }) => {
    const field = getMeasureField(fields, measures);
    return {
      general: {
        field,
        title: field,
        precision: 0,
      },
    };
  };

  getProps({ data, general, fieldProps }: RenderProps) {
    const row = data[0] || {};
    const field = general?.field;
    return {
      ...general,
      title: general?.title || fieldLabel(fieldProps, field),
      value: row[field],
    };
  }
}
