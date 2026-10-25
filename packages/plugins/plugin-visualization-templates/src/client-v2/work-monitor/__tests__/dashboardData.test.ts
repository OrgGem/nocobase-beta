/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import {
  buildDistribution,
  buildTimeBuckets,
  filterRecordsByDateRange,
  formatValue,
  getTimeBucketLabel,
  isCompletedRecord,
  toDate,
} from '../dashboardData';

describe('V2 work dashboard calculations', () => {
  it('preserves zero/false values and readable association labels', () => {
    expect(formatValue(0)).toBe('0');
    expect(formatValue({ value: false })).toBe('false');
    expect(formatValue({ id: 0 })).toBe('0');
    expect(formatValue([{ nickname: 'Alice' }, { title: 'Team' }])).toBe('Alice, Team');
    expect(toDate(0)?.getTime()).toBe(0);
    expect(toDate({})).toBeNull();
  });

  it('does not count incomplete or negated status labels as completed', () => {
    const config = { statusField: 'status', completedAtField: 'doneAt' };
    expect(isCompletedRecord({ status: 'incomplete' }, config)).toBe(false);
    expect(isCompletedRecord({ status: 'not completed' }, config)).toBe(false);
    expect(isCompletedRecord({ status: 'unsuccessful' }, config)).toBe(false);
    expect(isCompletedRecord({ status: 'DONE' }, config)).toBe(true);
    expect(isCompletedRecord({ doneAt: '2026-10-25', status: 'archived' }, config)).toBe(true);
  });

  it('uses the ISO week year at calendar-year boundaries', () => {
    expect(getTimeBucketLabel(new Date(2021, 0, 1), 'week')).toBe('2020-W53');
    expect(getTimeBucketLabel(new Date(2018, 11, 31), 'week')).toBe('2019-W01');
    expect(getTimeBucketLabel(new Date(2021, 0, 1), 'month')).toBe('2021-01');
  });

  it('groups records consistently and excludes invalid dates from the trend', () => {
    const records = [
      { owner: { name: 'Alice' }, date: '2026-10-01', status: 'done' },
      { owner: { name: 'Alice' }, date: '2026-10-02', status: 'incomplete' },
      { owner: { name: 'Bob' }, date: 'invalid', status: 'done' },
    ];
    expect(buildDistribution(records, 'owner')).toEqual([
      { label: 'Alice', count: 2 },
      { label: 'Bob', count: 1 },
    ]);
    expect(buildTimeBuckets(records, 'date', 'month', { statusField: 'status' })).toEqual([
      { label: '2026-10', count: 2, completed: 1 },
    ]);
  });

  it('includes both selected calendar days when filtering the report range', () => {
    const records = [
      { date: '2026-09-30T23:59:59' },
      { date: '2026-10-01T00:00:00' },
      { date: '2026-10-02T23:59:59' },
      { date: '2026-10-03T00:00:00' },
    ];
    expect(filterRecordsByDateRange(records, 'date', [dayjs('2026-10-01'), dayjs('2026-10-02')])).toEqual(
      records.slice(1, 3),
    );
    expect(filterRecordsByDateRange(records, 'date', null)).toBe(records);
  });
});
