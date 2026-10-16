import React, { useEffect, useState } from 'react';

import type { ChartType, FieldOption } from '@nocobase/plugin-data-visualization/client-v2';

import { tExpr } from '../locale';

export type DataRow = Record<string, unknown>;

export function toNumber(value: unknown, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

const NUMBER_LOCALE = 'en-US';

export function formatNumber(value: unknown, precision?: number, compact = false) {
  const numeric = toNumber(value);
  const options: Intl.NumberFormatOptions =
    typeof precision === 'number' && Number.isFinite(precision)
      ? { minimumFractionDigits: precision, maximumFractionDigits: precision }
      : { maximumFractionDigits: 2 };
  if (compact) {
    options.notation = 'compact';
    options.maximumFractionDigits = Math.min(options.maximumFractionDigits ?? 2, 2);
    options.minimumFractionDigits = Math.min(options.minimumFractionDigits ?? 0, 2);
  }
  try {
    return new Intl.NumberFormat(NUMBER_LOCALE, options).format(numeric);
  } catch {
    return String(numeric);
  }
}

export function getFirstField(fields: FieldOption[] = []) {
  return fields[0]?.value;
}

export function getSecondField(fields: FieldOption[] = []) {
  return fields[1]?.value || fields[0]?.value;
}

export function getMeasureField(fields: FieldOption[] = [], measures?: { field: string | string[]; alias?: string }[]) {
  const measure = measures?.[0];
  if (measure?.alias) {
    return measure.alias;
  }
  if (Array.isArray(measure?.field)) {
    return measure.field.filter(Boolean).join('.');
  }
  return measure?.field || getSecondField(fields);
}

export function getDimensionField(
  fields: FieldOption[] = [],
  dimensions?: { field: string | string[]; alias?: string }[],
) {
  const dimension = dimensions?.[0];
  if (dimension?.alias) {
    return dimension.alias;
  }
  if (Array.isArray(dimension?.field)) {
    return dimension.field.filter(Boolean).join('.');
  }
  return dimension?.field || getFirstField(fields);
}

export function sortRows(rows: DataRow[], field?: string, order: 'ascend' | 'descend' = 'descend') {
  if (!field) {
    return [...rows];
  }
  return [...rows].sort((a, b) => {
    const av = a[field];
    const bv = b[field];
    const an = toNumber(av, Number.NaN);
    const bn = toNumber(bv, Number.NaN);
    const result = Number.isNaN(an) || Number.isNaN(bn) ? String(av ?? '').localeCompare(String(bv ?? '')) : an - bn;
    return order === 'ascend' ? result : -result;
  });
}

export function fieldLabel(fieldProps: Record<string, { label?: string }> = {}, field?: string, fallback?: string) {
  if (!field) {
    return fallback || '';
  }
  return fieldProps[field]?.label || fallback || field;
}

export const fieldConfig = (name: string, title: string, required = true) => ({
  [name]: {
    title: tExpr(title),
    type: 'string',
    'x-decorator': 'FormItem',
    'x-component': 'Select',
    'x-reactions': '{{ useChartFields }}',
    required,
  },
});

export const inputConfig = (name: string, title: string, defaultValue?: string) => ({
  [name]: {
    title: tExpr(title),
    type: 'string',
    'x-decorator': 'FormItem',
    'x-component': 'Input',
    default: defaultValue,
  },
});

export const percentNumberConfig = (name: string, title: string, defaultValue?: number) => ({
  [name]: {
    title: tExpr(title),
    type: 'number',
    'x-decorator': 'FormItem',
    'x-component': 'InputNumber',
    default: defaultValue,
    'x-component-props': {
      min: 0,
      max: 100,
      addonAfter: '%',
    },
  },
});

export const numberConfig = (name: string, title: string, defaultValue?: number) => ({
  [name]: {
    title: tExpr(title),
    type: 'number',
    'x-decorator': 'FormItem',
    'x-component': 'InputNumber',
    default: defaultValue,
  },
});

export const selectConfig = (
  name: string,
  title: string,
  options: { label: string; value: string }[],
  defaultValue?: string,
) => ({
  [name]: {
    title: tExpr(title),
    type: 'string',
    'x-decorator': 'FormItem',
    'x-component': 'Select',
    default: defaultValue,
    enum: options.map((option) => ({
      ...option,
      label: option.label ? tExpr(option.label) : option.label,
    })),
  },
});

export const booleanConfig = (name: string, title: string, defaultValue = false) => ({
  [name]: {
    'x-content': tExpr(title),
    type: 'boolean',
    'x-decorator': 'FormItem',
    'x-component': 'Checkbox',
    default: defaultValue,
  },
});

const FALLBACK_PLOT_COLOR = '#30bf78';
const HEX_COLOR = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_COLOR = /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\)$/i;
const NAMED_COLOR = /^[a-z]+$/i;

// Color values come from the user-facing chart options, so anything that is not a plain
// color string must never reach a G2/antd-plots config: it would break the whole mark.
export function isValidPlotColor(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const color = value.trim();
  return HEX_COLOR.test(color) || RGB_COLOR.test(color) || NAMED_COLOR.test(color);
}

export function resolvePlotColor(value: unknown, fallback: string = FALLBACK_PLOT_COLOR) {
  return isValidPlotColor(value) ? value.trim() : fallback;
}

// `link` is rendered as `<a href>`, so anything that can execute script (e.g. `javascript:`) must be
// dropped before it reaches the DOM.
export function isSafeLink(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  const link = value.trim();
  return !/^(javascript|data|vbscript):/i.test(link);
}

type PlotComponents = Record<string, Record<string, React.ComponentType<unknown>>>;

let cachedPlots: PlotComponents | null = null;
let loadingPromise: Promise<PlotComponents> | null = null;

export function usePlotComponent<TProps>(name: string) {
  const [plots, setPlots] = useState<PlotComponents | null>(cachedPlots);

  useEffect(() => {
    if (cachedPlots) {
      // Another mount may have resolved the module between this render and this effect.
      setPlots(cachedPlots);
      return;
    }
    let cancelled = false;
    if (!loadingPromise) {
      loadingPromise = import('@ant-design/plots').then((module) => module as unknown as PlotComponents);
    }
    const pending = loadingPromise;
    pending
      .then((module) => {
        if (cancelled) return;
        cachedPlots = module;
        setPlots(module);
      })
      .catch(() => {
        // A rejected module keeps its promise forever, so drop it and let the next mount retry.
        if (loadingPromise === pending) {
          loadingPromise = null;
        }
        if (!cancelled) {
          setPlots(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!plots) return undefined;

  const [group, child] = name.split('.');
  const component = child
    ? plots[group]?.[child]
    : (plots as unknown as Record<string, React.ComponentType<TProps>>)[name];

  return component as React.ComponentType<TProps> | undefined;
}

export type AdvancedChart = ChartType;
