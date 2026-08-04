import React from 'react';

import { Chart, ChartType, RenderProps } from '@nocobase/plugin-data-visualization/client-v2';
import { Table, Tag } from 'antd';

import { tExpr } from '../locale';
import {
  booleanConfig,
  fieldConfig,
  getDimensionField,
  getMeasureField,
  numberConfig,
  selectConfig,
  sortRows,
} from './utils';

type RankedTableProps = {
  rows: Record<string, unknown>[];
  columns: React.ComponentProps<typeof Table>['columns'];
  compact?: boolean;
};

const RankedTableComponent: React.FC<RankedTableProps> = ({ rows, columns, compact }) => (
  <Table
    rowKey={(record, index) => String(record.__rank || index)}
    size={compact ? 'small' : 'middle'}
    pagination={false}
    columns={columns}
    dataSource={rows}
  />
);

export class RankedTable extends Chart {
  constructor() {
    super({
      name: 'ranked-table',
      title: tExpr('Ranked Table'),
      Component: RankedTableComponent,
      config: [
        fieldConfig('labelField', 'Label field'),
        fieldConfig('valueField', 'Value field'),
        fieldConfig('extraField', 'Extra field', false),
        numberConfig('limit', 'Limit', 10),
        selectConfig(
          'sortOrder',
          'Sort',
          [
            { label: 'Descending', value: 'descend' },
            { label: 'Ascending', value: 'ascend' },
          ],
          'descend',
        ),
        booleanConfig('showRank', 'Show rank', true),
        booleanConfig('compact', 'Compact', true),
      ],
    });
  }

  init: ChartType['init'] = (fields, { measures, dimensions }) => ({
    general: {
      labelField: getDimensionField(fields, dimensions),
      valueField: getMeasureField(fields, measures),
      limit: 10,
      sortOrder: 'descend',
      showRank: true,
      compact: true,
    },
  });

  getProps({ data, general, fieldProps }: RenderProps) {
    const rows = sortRows(data, general?.valueField, general?.sortOrder)
      .slice(0, general?.limit ?? 10)
      .map((row, index) => ({ ...row, __rank: index + 1 }));
    const columns = [
      general?.showRank
        ? {
            title: '#',
            dataIndex: '__rank',
            width: 56,
            render: (value: number) => <Tag color={value <= 3 ? 'blue' : undefined}>{value}</Tag>,
          }
        : null,
      {
        title: fieldProps[general?.labelField]?.label || general?.labelField,
        dataIndex: general?.labelField,
      },
      {
        title: fieldProps[general?.valueField]?.label || general?.valueField,
        dataIndex: general?.valueField,
        align: 'right',
      },
      general?.extraField
        ? {
            title: fieldProps[general.extraField]?.label || general.extraField,
            dataIndex: general.extraField,
          }
        : null,
    ].filter(Boolean);
    return {
      ...general,
      rows,
      columns,
    };
  }
}
