import React from 'react';

import { Chart, ChartType, RenderProps } from '@nocobase/plugin-data-visualization/client-v2';
import { Timeline, Typography } from 'antd';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

import { tExpr } from '../locale';
import { fieldConfig, getDimensionField, selectConfig } from './utils';

dayjs.extend(relativeTime);

const { Text } = Typography;

type TimelineChartProps = {
  items: {
    label?: string;
    color?: string;
    children: React.ReactNode;
  }[];
};

const TimelineChartComponent: React.FC<TimelineChartProps> = ({ items }) => <Timeline mode="left" items={items} />;

const FALLBACK_TITLE = '—';
const DEFAULT_FORMAT = 'YYYY-MM-DD HH:mm';

export class TimelineChart extends Chart {
  constructor() {
    super({
      name: 'timeline',
      title: tExpr('Timeline'),
      Component: TimelineChartComponent,
      config: [
        fieldConfig('timeField', 'Time field'),
        fieldConfig('titleField', 'Title field', false),
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
        selectConfig(
          'labelFormat',
          'Date format',
          [
            { label: 'Date and time', value: 'YYYY-MM-DD HH:mm' },
            { label: 'Date only', value: 'YYYY-MM-DD' },
            { label: 'Relative time', value: 'relative' },
          ],
          'YYYY-MM-DD HH:mm',
        ),
      ],
    });
  }

  init: ChartType['init'] = (fields, { dimensions }) => ({
    general: {
      timeField: getDimensionField(fields, dimensions),
      titleField: '',
      sortOrder: 'descend',
      labelFormat: 'YYYY-MM-DD HH:mm',
    },
  });

  getProps({ data, general }: RenderProps) {
    const timeField = general?.timeField;
    const sorted = [...data].sort((a, b) => {
      const av = dayjs(a[timeField]).valueOf();
      const bv = dayjs(b[timeField]).valueOf();
      if (Number.isNaN(av) && Number.isNaN(bv)) return 0;
      if (Number.isNaN(av)) return 1;
      if (Number.isNaN(bv)) return -1;
      return general?.sortOrder === 'ascend' ? av - bv : bv - av;
    });
    const labelFormat = general?.labelFormat || DEFAULT_FORMAT;
    const items = sorted.map((row) => {
      const date = dayjs(row[timeField]);
      const label = date.isValid()
        ? labelFormat === 'relative'
          ? date.fromNow()
          : date.format(labelFormat)
        : undefined;
      return {
        label,
        color: general?.colorField ? String(row[general.colorField] ?? '') || undefined : undefined,
        children: (
          <div>
            <div>{String(row[general?.titleField] ?? FALLBACK_TITLE)}</div>
            {general?.descriptionField ? (
              <Text type="secondary">{String(row[general.descriptionField] ?? '')}</Text>
            ) : null}
          </div>
        ),
      };
    });
    return {
      ...general,
      items,
    };
  }
}
