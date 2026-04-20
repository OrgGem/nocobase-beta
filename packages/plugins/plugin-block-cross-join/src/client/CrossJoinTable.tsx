/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useMemo } from 'react';
import { Table, Empty, Spin } from 'antd';
import { useCrossJoinContext } from './CrossJoinBlockProvider';

export const CrossJoinTable: React.FC = () => {
  const ctx = useCrossJoinContext();

  const columns = useMemo(() => {
    if (!ctx?.data?.length) return [];

    const config = ctx.config;

    // If columns are configured, use them
    if (config?.columns?.length) {
      const cols: any[] = [];
      for (const col of config.columns) {
        if (col.jsonExpand?.length) {
          for (const jsonKey of col.jsonExpand) {
            const alias = col.alias ? `${col.alias}.${jsonKey}` : `${col.field}.${jsonKey}`;
            cols.push({
              title: alias,
              dataIndex: alias,
              key: alias,
              ellipsis: true,
              render: (val: any) => (val != null ? String(val) : '-'),
            });
          }
        } else {
          const key = col.alias || col.field;
          cols.push({
            title: key,
            dataIndex: key,
            key,
            ellipsis: true,
            render: (val: any) => {
              if (val == null) return '-';
              if (typeof val === 'object') return JSON.stringify(val);
              return String(val);
            },
          });
        }
      }
      return cols;
    }

    // Fallback: auto-detect columns from first row
    // Use explicit render to avoid Ant Design interpreting dot-keys (e.g. "primary.id") as nested paths
    const firstRow = ctx.data[0];
    return Object.keys(firstRow).map((key) => ({
      title: key,
      dataIndex: key,
      key,
      ellipsis: true,
      render: (_val: any, record: any) => {
        const val = record[key];
        if (val == null) return '-';
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val);
      },
    }));
  }, [ctx?.data, ctx?.config]);

  if (!ctx) return null;

  if (ctx.loading) {
    return (
      <div style={{ textAlign: 'center', padding: 40 }}>
        <Spin />
      </div>
    );
  }

  if (!ctx.data?.length) {
    return <Empty description="No data" />;
  }

  return (
    <Table
      dataSource={ctx.data}
      columns={columns}
      rowKey={(_, index) => String(index)}
      size="middle"
      scroll={{ x: 'max-content' }}
      pagination={{
        current: ctx.pagination.page,
        pageSize: ctx.pagination.pageSize,
        total: ctx.pagination.total,
        showSizeChanger: true,
        showTotal: (total) => `Total ${total} rows`,
        onChange: (page, pageSize) => {
          ctx.setPage(page);
          ctx.setPageSize(pageSize);
        },
      }}
    />
  );
};
