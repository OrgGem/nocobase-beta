/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { BlockModel } from '@nocobase/client-v2';
import { tExpr } from '@nocobase/flow-engine';
import React from 'react';
import { Table, Empty, Spin } from 'antd';
import { CrossJoinConfigurator } from './CrossJoinConfigurator';

interface JoinDef {
  dataSource: string;
  collection: string;
  joinType: 'left' | 'inner';
  leftField: string;
  rightField: string;
}

interface ColumnDef {
  source: number;
  field: string;
  alias?: string;
  jsonExpand?: string[];
}

interface CrossJoinConfig {
  primarySource: { dataSource: string; collection: string };
  joins: JoinDef[];
  columns: ColumnDef[];
}

export class CrossJoinBlockModel extends BlockModel {
  private _data: Record<string, unknown>[] = [];
  private _loading = false;
  private _page = 1;
  private _pageSize = 20;
  private _total = 0;
  private _configuratorOpen = false;

  get config(): CrossJoinConfig | undefined {
    return this.stepParams?.crossJoinSettings?.config as CrossJoinConfig | undefined;
  }

  private async fetchData() {
    const cfg = this.config;
    if (!cfg?.primarySource?.collection) return;

    this._loading = true;
    this.rerender();
    try {
      const res = await this.context.apiClient.request({
        url: 'crossJoin:query',
        method: 'post',
        data: {
          config: cfg,
          page: this._page,
          pageSize: this._pageSize,
        },
      });
      const body = res?.data;
      this._data = body?.data || [];
      this._total = body?.meta?.count || 0;
    } catch (err) {
      console.error('CrossJoin query failed:', err);
      this._data = [];
    } finally {
      this._loading = false;
      this.rerender();
    }
  }

  protected onMount() {
    super.onMount();
    this.fetchData();
  }

  openConfigurator() {
    this._configuratorOpen = true;
    this.rerender();
  }

  closeConfigurator() {
    this._configuratorOpen = false;
    this.rerender();
  }

  handleConfigSubmit(config: CrossJoinConfig) {
    this._configuratorOpen = false;
    this.setStepParams('crossJoinSettings', { config });
    this._page = 1;
    this.fetchData();
  }

  private buildColumns() {
    const cfg = this.config;
    if (cfg?.columns?.length) {
      const cols: { title: string; dataIndex: string; key: string; ellipsis: boolean; render: (val: unknown) => string }[] = [];
      for (const col of cfg.columns) {
        if (col.jsonExpand?.length) {
          for (const jsonKey of col.jsonExpand) {
            const alias = col.alias ? `${col.alias}.${jsonKey}` : `${col.field}.${jsonKey}`;
            cols.push({
              title: alias,
              dataIndex: alias,
              key: alias,
              ellipsis: true,
              render: (val: unknown) => (val != null ? String(val) : '-'),
            });
          }
        } else {
          const key = col.alias || col.field;
          cols.push({
            title: key,
            dataIndex: key,
            key,
            ellipsis: true,
            render: (val: unknown) => {
              if (val == null) return '-';
              if (typeof val === 'object') return JSON.stringify(val);
              return String(val);
            },
          });
        }
      }
      return cols;
    }

    if (this._data.length > 0) {
      const firstRow = this._data[0];
      return Object.keys(firstRow).map((key) => ({
        title: key,
        dataIndex: key,
        key,
        ellipsis: true,
        render: (_val: unknown, record: Record<string, unknown>) => {
          const val = record[key];
          if (val == null) return '-';
          if (typeof val === 'object') return JSON.stringify(val);
          return String(val);
        },
      }));
    }

    return [];
  }

  // Only override renderComponent — base BlockModel.render() wraps this in BlockItemCard
  // with title, description, heightMode, and settings toolbar automatically.
  renderComponent() {
    const columns = this.buildColumns();

    return (
      <>
        {this._loading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin />
          </div>
        ) : !this._data.length ? (
          <Empty description="No data" />
        ) : (
          <Table
            dataSource={this._data}
            columns={columns}
            rowKey={(_, index) => String(index)}
            size="middle"
            scroll={{ x: 'max-content' }}
            pagination={{
              current: this._page,
              pageSize: this._pageSize,
              total: this._total,
              showSizeChanger: true,
              showTotal: (total) => `Total ${total} rows`,
              onChange: (page, pageSize) => {
                this._page = page;
                this._pageSize = pageSize;
                this.fetchData();
              },
            }}
          />
        )}
        <CrossJoinConfigurator
          visible={this._configuratorOpen}
          onCancel={() => this.closeConfigurator()}
          onSubmit={(config) => this.handleConfigSubmit(config)}
          initialConfig={this.config}
        />
      </>
    );
  }
}

CrossJoinBlockModel.define({
  label: tExpr('Cross Join'),
  createModelOptions: {
    use: 'CrossJoinBlockModel',
  },
});

// Only register the custom edit-mapping step.
// Title, description, block height, linkage rules, and remove are all inherited
// from BlockModel.registerFlow('cardSettings') automatically.
CrossJoinBlockModel.registerFlow({
  key: 'crossJoinSettings',
  title: tExpr('Cross Join settings'),
  sort: -100,
  steps: {
    editMapping: {
      title: tExpr('Edit mapping'),
      useRawParams: true,
      handler(ctx) {
        (ctx.model as CrossJoinBlockModel).openConfigurator();
      },
    },
  },
});

