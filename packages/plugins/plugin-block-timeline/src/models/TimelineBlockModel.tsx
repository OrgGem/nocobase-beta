/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { BlockSceneEnum, CollectionBlockModel } from '@nocobase/client-v2';
import { MultiRecordResource, observer } from '@nocobase/flow-engine';
import { Button, Empty, Spin, Timeline } from 'antd';
import React from 'react';
import { tExpr, useT } from '../i18n';
import {
  DATE_FIELD_TYPES,
  getFieldEnumColor,
  isSupportedByValues,
  normalizeColorValue,
  normalizePageSize,
  sortRecordsByDate,
  TEXT_FIELD_TYPES,
  type TimelineFieldNames,
  type TimelineRecord,
} from './TimelineBlockModel.helpers';
import { registerTimelineBlockModelSettings } from './TimelineBlockModel.settings';

export class TimelineBlockModel extends CollectionBlockModel {
  static scene = BlockSceneEnum.many;

  get resource(): MultiRecordResource {
    return super.resource as MultiRecordResource;
  }

  createResource(): MultiRecordResource {
    const resource = this.context.createResource(MultiRecordResource);
    resource.setPageSize(this.getPageSize());
    resource.setSort([this.getDateFieldName()]);
    return resource;
  }

  getCollectionFields(): Array<Record<string, unknown>> {
    const collection = this.collection as { getFields?: () => Array<Record<string, unknown>> } | undefined;
    return collection?.getFields?.() || [];
  }

  getFieldOptions(types: string[]): Array<{ label: string; value: string }> {
    return this.getCollectionFields()
      .filter((field) => {
        return (
          isSupportedByValues(field['type'], types) ||
          isSupportedByValues(field['interface'], types) ||
          isSupportedByValues((field['uiSchema'] as Record<string, unknown> | undefined)?.['type'] as unknown, types)
        );
      })
      .map((field) => ({
        label: String(
          field['title'] || (field['uiSchema'] as Record<string, unknown> | undefined)?.['title'] || field['name'],
        ),
        value: String(field['name']),
      }));
  }

  getFieldNames(): TimelineFieldNames {
    const fieldNames = this.props?.fieldNames || {};
    const dateOptions = this.getFieldOptions(DATE_FIELD_TYPES);
    const titleOptions = this.getFieldOptions(TEXT_FIELD_TYPES);
    const fallbackDate = dateOptions.find((option) => option.value === 'createdAt')?.value || dateOptions[0]?.value;
    const fallbackTitle =
      titleOptions[0]?.value ||
      (Array.isArray(this.collection?.filterTargetKey)
        ? this.collection.filterTargetKey[0]
        : this.collection?.filterTargetKey) ||
      'id';
    return {
      date: fieldNames.date || fallbackDate || 'createdAt',
      title: fieldNames.title || fallbackTitle,
      content: fieldNames.content,
      status: fieldNames.status,
    };
  }

  getDateFieldName(): string {
    return this.getFieldNames().date;
  }

  getPageSize(): number {
    return normalizePageSize(this.props?.pageSize ?? this.getStepParams('timelineSettings', 'pageSize')?.pageSize);
  }

  getOrder(): 'asc' | 'desc' {
    const order = this.props?.order ?? this.getStepParams('timelineSettings', 'order')?.order;
    return order === 'asc' ? 'asc' : 'desc';
  }

  isColorByStatusEnabled(): boolean {
    return this.props?.colorByStatus ?? this.getStepParams('timelineSettings', 'colorByStatus')?.colorByStatus ?? false;
  }

  getRecords(): TimelineRecord[] {
    const records = this.resource.getData() || [];
    return sortRecordsByDate(records, this.getDateFieldName(), this.getOrder());
  }

  getRecordColor(record: TimelineRecord): string | undefined {
    if (!this.isColorByStatusEnabled()) {
      return undefined;
    }
    const statusFieldName = this.getFieldNames().status;
    if (!statusFieldName) {
      return undefined;
    }
    const collection = this.collection as { getField?: (name: string) => unknown } | undefined;
    const statusField = collection?.getField?.(statusFieldName);
    const value = record[statusFieldName];
    return getFieldEnumColor(statusField, value) || normalizeColorValue(value);
  }

  async loadMore(): Promise<void> {
    const current = this.resource.getPageSize() || this.getPageSize();
    const next = current * 2;
    this.resource.loading = true;
    this.resource.setPage(1);
    this.resource.setPageSize(next);
    this.setProps({ pageSize: next });
    await this.resource.refresh();
  }

  hasMore(): boolean {
    const total = this.resource.getMeta('count');
    if (typeof total !== 'number') {
      return false;
    }
    return (this.resource.getData() || []).length < total;
  }

  renderComponent(): React.ReactElement {
    return <TimelineView model={this} />;
  }
}

const formatDate = (value: unknown): string => {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const date = new Date(value as string | number);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '';
};

export const TimelineView = observer(
  ({ model }: { model: TimelineBlockModel }) => {
    const t = useT();
    const loading = model.resource.loading;
    const records = model.getRecords();
    const fieldNames = model.getFieldNames();

    const items = records.map((record) => {
      const color = model.getRecordColor(record);
      const dateText = formatDate(record[fieldNames.date]);
      const children = (
        <div>
          <div style={{ fontWeight: 500 }}>
            {String(record[fieldNames.title] ?? '')}
            {dateText ? (
              <span style={{ color: 'rgba(0, 0, 0, 0.45)', fontWeight: 400, marginLeft: 8 }}>{dateText}</span>
            ) : null}
          </div>
          {fieldNames.content && record[fieldNames.content] != null && record[fieldNames.content] !== '' ? (
            <div style={{ color: 'rgba(0, 0, 0, 0.65)', marginTop: 4 }}>{String(record[fieldNames.content])}</div>
          ) : null}
        </div>
      );
      return color ? { children, color } : { children };
    });

    return (
      <Spin spinning={!!loading}>
        {items.length === 0 && !loading ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('No data')} />
        ) : (
          <Timeline items={items} />
        )}
        {!loading && model.hasMore() ? (
          <div style={{ textAlign: 'center' }}>
            <Button type="link" onClick={() => model.loadMore()}>
              {t('Load more')}
            </Button>
          </div>
        ) : null}
      </Spin>
    );
  },
  { displayName: 'TimelineView' },
);

TimelineBlockModel.define({
  label: tExpr('Timeline'),
  group: tExpr('Content'),
  createModelOptions: {
    use: 'TimelineBlockModel',
    props: {
      colorByStatus: false,
      order: 'desc',
      pageSize: 20,
    },
  },
  sort: 500,
});

registerTimelineBlockModelSettings(TimelineBlockModel);
