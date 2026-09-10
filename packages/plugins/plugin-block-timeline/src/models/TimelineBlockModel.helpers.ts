/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { theme } from 'antd';

export type TimelineRecord = Record<string, unknown>;

export type TimelineFieldNames = {
  date: string;
  title: string;
  content?: string;
  status?: string;
};

export const DATE_FIELD_TYPES = [
  'date',
  'datetime',
  'dateOnly',
  'datetimeNoTz',
  'unixTimestamp',
  'createdAt',
  'updatedAt',
];

export const TEXT_FIELD_TYPES = ['string', 'text'];

export const COLOR_FIELD_TYPES = ['select', 'radio', 'color'];

export const DEFAULT_PRESET_COLOR = '#d9d9d9';

export const isSupportedByValues = (value: unknown, values: string[]) => {
  return typeof value === 'string' && values.includes(value);
};

const hasOwn = (target: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(target, key);

export const normalizePageSize = (value?: unknown) => {
  const pageSize = Number(value);
  return Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 20;
};

export const normalizeColorValue = (value: unknown) => {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return (record.hex || record.hexString || record.color || record.value) as string | undefined;
  }

  const color = String(value);
  if (color === 'default') {
    return DEFAULT_PRESET_COLOR;
  }

  const seedColor = (theme.defaultSeed as Record<string, string>)[color];
  if (seedColor) {
    return seedColor;
  }

  return color;
};

export const getFieldEnumColor = (field: unknown, value: unknown) => {
  const normalizedValue = normalizeColorValue(value);
  if (!normalizedValue) {
    return undefined;
  }

  const enumOptions = Array.isArray((field as { uiSchema?: { enum?: unknown[] } })?.uiSchema?.enum)
    ? ((field as { uiSchema: { enum: unknown[] } }).uiSchema.enum as Array<Record<string, unknown>>)
    : [];

  const option = enumOptions.find((item) => {
    return String(item?.value ?? item?.name ?? item?.id ?? '') === String(normalizedValue);
  });

  return option?.color;
};

type TimelineFieldNamesHost = {
  props?: { fieldNames?: Partial<TimelineFieldNames> };
  setProps: (props: Record<string, unknown>) => void;
  setStepParams?: (flowKey: string, stepKey: string, params: Record<string, unknown>) => void;
};

export const applyTimelineFieldNames = (model: TimelineFieldNamesHost, params: Record<string, unknown>) => {
  const fieldNames: TimelineFieldNames = { ...(model.props?.fieldNames || {}) } as TimelineFieldNames;

  const setFieldName = (key: keyof TimelineFieldNames, value: unknown, optional = false) => {
    const isEmpty = value === undefined || value === null || value === '';
    if (optional && isEmpty) {
      delete fieldNames[key];
      params[key] = null;
      return;
    }
    fieldNames[key] = value as string;
  };

  if (hasOwn(params, 'date')) {
    setFieldName('date', params.date);
  }
  if (hasOwn(params, 'title')) {
    setFieldName('title', params.title);
  }
  if (hasOwn(params, 'content')) {
    setFieldName('content', params.content, true);
  }
  if (hasOwn(params, 'status')) {
    setFieldName('status', params.status, true);
  }

  model.setProps({ fieldNames });

  model.setStepParams?.('timelineSettings', 'fields', {
    date: fieldNames.date,
    title: fieldNames.title,
    content: fieldNames.content ?? null,
    status: fieldNames.status ?? null,
  });
};

const parseDateValue = (record: TimelineRecord, fieldName?: string): number => {
  if (!fieldName) {
    return 0;
  }
  const raw = record?.[fieldName];
  if (raw === null || raw === undefined || raw === '') {
    return 0;
  }
  const timestamp = new Date(raw as string | number).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

export const sortRecordsByDate = (records: TimelineRecord[], dateField?: string, order: 'asc' | 'desc' = 'desc') => {
  const sorted = [...records];
  sorted.sort((a, b) => {
    const diff = parseDateValue(a, dateField) - parseDateValue(b, dateField);
    if (diff === 0) {
      const idA = Number(a?.id ?? 0);
      const idB = Number(b?.id ?? 0);
      return Number.isFinite(idA) && Number.isFinite(idB) ? idA - idB : 0;
    }
    return order === 'asc' ? diff : -diff;
  });
  return sorted;
};
