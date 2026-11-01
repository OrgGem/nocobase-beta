/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Dayjs } from 'dayjs';
export type WorkRecord = Record<string, unknown>;
export type DashboardDateRange = [Dayjs | null, Dayjs | null] | null;
export type DashboardConfig = {
  dataSource?: string;
  collection?: string;
  titleField?: string;
  statusField?: string;
  assigneeField?: string;
  priorityField?: string;
  createdAtField?: string;
  updatedAtField?: string;
  completedAtField?: string;
  dueDateField?: string;
};

export type DistributionItem = {
  label: string;
  count: number;
};
export type TimeGrain = 'year' | 'month' | 'week' | 'day';
export type TimeBucketItem = {
  label: string;
  count: number;
  completed: number;
};
const completedStatusKeywords = ['done', 'completed', 'complete', 'closed', 'resolved', 'finished', 'success'];
export const normalizeText = (value: unknown) =>
  String(formatValue(value) || '')
    .trim()
    .toLowerCase();

export const formatValue = (value: unknown): string => {
  if (value === null || value === undefined || value === '') {
    return '-';
  }
  if (Array.isArray(value)) {
    return (
      value
        .map(formatValue)
        .filter((item) => item !== '-')
        .join(', ') || '-'
    );
  }
  if (typeof value === 'object') {
    const item = value as Record<string, unknown>;
    const label = [
      item.title,
      item.name,
      item.nickname,
      item.username,
      item.email,
      item.label,
      item.id,
      item.value,
    ].find((candidate) => candidate != null && candidate !== '');
    return label == null ? '-' : String(label);
  }
  return String(value);
};

export const formatDate = (value: unknown) => {
  if (value == null || value === '') {
    return '-';
  }
  const date = toDate(value);
  if (!date) return formatValue(value);
  if (Number.isNaN(date.getTime())) {
    return formatValue(value);
  }
  return date.toLocaleString();
};

export const getFieldValue = (record: WorkRecord, field?: string) => (field ? record?.[field] : undefined);

export const isCompletedRecord = (record: WorkRecord, config: DashboardConfig) => {
  if (getFieldValue(record, config.completedAtField)) {
    return true;
  }
  const status = normalizeText(getFieldValue(record, config.statusField));
  return completedStatusKeywords.includes(status);
};

export const toDate = (value: unknown) => {
  if (value == null || value === '') {
    return null;
  }
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const padDatePart = (value: number) => String(value).padStart(2, '0');

const getWeekNumber = (date: Date) => {
  const normalized = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = normalized.getUTCDay() || 7;
  normalized.setUTCDate(normalized.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(normalized.getUTCFullYear(), 0, 1));
  return {
    year: normalized.getUTCFullYear(),
    week: Math.ceil(((normalized.getTime() - yearStart.getTime()) / 86400000 + 1) / 7),
  };
};

export const getTimeBucketLabel = (value: unknown, grain: TimeGrain) => {
  const date = toDate(value);
  if (!date) {
    return '-';
  }
  const year = date.getFullYear();
  const month = padDatePart(date.getMonth() + 1);
  const day = padDatePart(date.getDate());
  if (grain === 'year') {
    return String(year);
  }
  if (grain === 'month') {
    return `${year}-${month}`;
  }
  if (grain === 'week') {
    const week = getWeekNumber(date);
    return `${week.year}-W${padDatePart(week.week)}`;
  }
  return `${year}-${month}-${day}`;
};

export const escapeXml = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

export const svgEscape = escapeXml;

export const buildDistribution = (records: WorkRecord[], field?: string): DistributionItem[] => {
  if (!field) {
    return [];
  }
  const counts = new Map<string, number>();
  records.forEach((record) => {
    const label = formatValue(getFieldValue(record, field));
    counts.set(label, (counts.get(label) || 0) + 1);
  });
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
};

export const buildTimeBuckets = (
  records: WorkRecord[],
  timeField: string | undefined,
  grain: TimeGrain,
  config: DashboardConfig,
): TimeBucketItem[] => {
  if (!timeField) {
    return [];
  }
  const buckets = new Map<string, TimeBucketItem>();
  records.forEach((record) => {
    const label = getTimeBucketLabel(getFieldValue(record, timeField), grain);
    if (label === '-') {
      return;
    }
    const bucket = buckets.get(label) || { label, count: 0, completed: 0 };
    bucket.count += 1;
    if (isCompletedRecord(record, config)) {
      bucket.completed += 1;
    }
    buckets.set(label, bucket);
  });
  return Array.from(buckets.values()).sort((a, b) => a.label.localeCompare(b.label));
};

export const filterRecordsByDateRange = (records: WorkRecord[], timeField?: string, range?: DashboardDateRange) => {
  if (!timeField || !range?.[0] || !range?.[1]) {
    return records;
  }
  const start = range[0].startOf('day').valueOf();
  const end = range[1].endOf('day').valueOf();
  return records.filter((record) => {
    const value = toDate(getFieldValue(record, timeField));
    if (!value) {
      return false;
    }
    const time = value.getTime();
    return time >= start && time <= end;
  });
};
