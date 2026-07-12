import React from 'react';

import { Chart, ChartType, RenderProps } from '@nocobase/plugin-data-visualization/client-v2';
import { Timeline, Typography } from 'antd';
import dayjs from 'dayjs';

import { tExpr } from '../locale';
import { fieldConfig, getDimensionField, getMeasureField, selectConfig } from './utils';

const { Text } = Typography;

type TimelineChartProps = {
  items: React.ComponentProps<typeof Timeline>['items'];
};

const TimelineChartComponent: React.FC<TimelineChartProps> = ({ items }) => <Timeline mode="left" items={items} />;

export class TimelineChart extends Chart {
  constructor() {
    super({
      name: 'timeline',
      title: tExpr('Timeline'),
      Component: TimelineChartComponent,
      config: [
        fieldConfig('timeField', 'Time field'),
        fieldConfig('titleField', 'Title field'),
        fieldConfig('descriptionField', 'Description field', false),
        fieldConfig('colorField', 'Color field', false),
        selectConfig(
          'sortOrder',
          'Sort',
          [
            { label: 'Newest first', value: 'descend' },
            { label: 'Oldest first', value: 'ascend' },
          ],
          'descend',
        ),
      ],
    });
  }

  init: ChartType['init'] = (fields, { measures, dimensions }) => ({
    general: {
      timeField: getDimensionField(fields, dimensions),
      titleField: getMeasureField(fields, measures),
      sortOrder: 'descend',
    },
  });

  getProps({ data, general }: RenderProps) {
    const sorted = [...data].sort((a, b) => {
      const av = dayjs(a[general?.timeField] as string).valueOf();
      const bv = dayjs(b[general?.timeField] as string).valueOf();
      return general?.sortOrder === 'ascend' ? av - bv : bv - av;
    });
    return {
      ...general,
      items: sorted.map((row) => ({
        label: row[general?.timeField] ? dayjs(row[general.timeField] as string).format('YYYY-MM-DD HH:mm') : undefined,
        color: (row[general?.colorField] as string) || undefined,
        children: (
          <div>
            <div>{String(row[general?.titleField] ?? '')}</div>
            {general?.descriptionField ? (
              <Text type="secondary">{String(row[general.descriptionField] ?? '')}</Text>
            ) : null}
          </div>
        ),
      })),
    };
  }
}
