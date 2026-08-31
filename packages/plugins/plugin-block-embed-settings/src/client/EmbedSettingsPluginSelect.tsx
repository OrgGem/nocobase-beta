import React, { useEffect, useMemo, useState } from 'react';
import { Select } from 'antd';
import { useApp } from '@nocobase/client-v2';
import type {
  EmbedSettingsPluginOption,
  EmbedSettingsTabOption,
  AllowedPluginRecord,
  PluginSettingEntry,
  EmbedSettingsPluginOptionsResult,
} from './types';

const TEMPLATE_RE = /\{\{\s*t\(\s*(['"])(.*?)\1\s*(?:,\s*(\{.*?\}))?\)\s*\}\}/;

/**
 * Resolve a possibly-`{{t("...")}}`-wrapped label to a display string using the
 * v2 app i18n instance.
 */
function stringifyLabel(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value || fallback;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    const label = value.map((item) => stringifyLabel(item, '')).join('');
    return label || fallback;
  }
  if (React.isValidElement(value)) {
    return stringifyLabel((value.props as { children?: unknown }).children, fallback);
  }
  return fallback;
}

function compileLabel(
  app: { i18n?: { t?: (key: string, options?: Record<string, unknown>) => unknown } },
  value: unknown,
  fallback: string,
): string {
  if (typeof value !== 'string') return stringifyLabel(value, fallback);
  const match = value.match(TEMPLATE_RE);
  if (!match) return value || fallback;
  const key = match[2];
  let options: Record<string, unknown> | undefined;
  if (match[3]) {
    try {
      options = JSON.parse(match[3].replace(/(\w+):/g, '"$1":').replace(/'/g, '"'));
    } catch {
      options = undefined;
    }
  }
  const translated = app?.i18n?.t?.(key, options);
  return stringifyLabel(translated, fallback);
}

function isRenderablePage(page: PluginSettingEntry | undefined): boolean {
  if (!page) return false;
  return Boolean(page.Component || page.componentLoader);
}

/**
 * Collect the embeddable settings tabs for a given top-level settings menu key,
 * using the v2 flat `pluginSettingsManager.getList()` snapshot.
 */
export function collectEmbeddablePluginTabs(
  app: {
    pluginSettingsManager: { has: (name: string) => boolean; get: (name: string) => PluginSettingEntry | undefined };
    i18n?: { t?: (key: string, options?: Record<string, unknown>) => unknown };
  },
  pluginName?: string,
): EmbedSettingsTabOption[] {
  if (!pluginName || !app.pluginSettingsManager.has(pluginName)) return [];
  const setting = app.pluginSettingsManager.get(pluginName);
  if (!setting) return [];

  const children = Array.isArray(setting.children) ? setting.children.filter(isRenderablePage) : [];
  if (children.length > 0) {
    return children.map((child: PluginSettingEntry) => ({
      value: child.name || `${setting.name}.${child.key}`,
      label: compileLabel(app, child.title || child.label, child.key || child.name),
      componentLoader: child.componentLoader,
      Component: child.Component,
    }));
  }

  if (isRenderablePage(setting)) {
    return [
      {
        value: setting.name,
        label: compileLabel(app, setting.title || setting.label, setting.name),
        componentLoader: setting.componentLoader,
        Component: setting.Component,
      },
    ];
  }

  return [];
}

/**
 * Collect all top-level settings menus that expose at least one embeddable tab.
 */
export function collectEmbeddablePlugins(app: {
  pluginSettingsManager: {
    getList?: () => PluginSettingEntry[];
    has: (name: string) => boolean;
    get: (name: string) => PluginSettingEntry | undefined;
  };
  i18n?: { t?: (key: string, options?: Record<string, unknown>) => unknown };
}): EmbedSettingsPluginOption[] {
  const list = app.pluginSettingsManager.getList?.() || [];
  const results: EmbedSettingsPluginOption[] = [];
  for (const setting of list) {
    const key = setting.name;
    if (!key || key.includes(':')) continue;
    if (collectEmbeddablePluginTabs(app, key).length === 0) continue;
    results.push({ value: key, label: compileLabel(app, setting.title || setting.label, key) });
  }
  return results.sort((a, b) => a.label.localeCompare(b.label));
}

export function normalizeAllowedRecords(data: unknown): AllowedPluginRecord[] {
  const responseData = data as
    | { data?: { data?: AllowedPluginRecord[] } | AllowedPluginRecord[] }
    | AllowedPluginRecord[]
    | undefined;
  let records: unknown;
  if (Array.isArray(responseData)) {
    records = responseData;
  } else if (responseData && typeof responseData === 'object' && 'data' in responseData) {
    const inner = responseData.data;
    if (Array.isArray(inner)) {
      records = inner;
    } else if (inner && typeof inner === 'object' && 'data' in inner) {
      records = (inner as { data: AllowedPluginRecord[] }).data;
    }
  }
  return Array.isArray(records) ? records : [];
}

export function useEnabledEmbedSettingsPluginOptions(): EmbedSettingsPluginOptionsResult {
  const app = useApp();
  const api = app.apiClient;
  const [records, setRecords] = useState<AllowedPluginRecord[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .request({
        url: 'embedAllowedPlugins:list',
        params: { filter: { enabled: true }, pageSize: 200 },
        signal: controller.signal,
      })
      .then(({ data }: { data: unknown }) => {
        if (!controller.signal.aborted) setRecords(normalizeAllowedRecords(data));
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted && !(err instanceof DOMException && err.name === 'AbortError')) {
          setRecords([]);
        }
      });
    return () => {
      controller.abort();
    };
  }, [api]);

  const options = useMemo(() => {
    if (!records) return [];
    const allowedTitles = new Map(records.map((record: AllowedPluginRecord) => [record.pluginName, record.title]));
    return collectEmbeddablePlugins(app)
      .filter((option) => allowedTitles.has(option.value))
      .map((option) => ({
        ...option,
        label: stringifyLabel(allowedTitles.get(option.value), option.label),
      }));
  }, [app, records]);

  return {
    loading: records === null,
    options,
  };
}

export const EmbedSettingsPluginSelect: React.FC<{
  value?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  [key: string]: unknown;
}> = (props) => {
  const { loading, options } = useEnabledEmbedSettingsPluginOptions();

  return (
    <Select
      {...props}
      options={options}
      loading={loading}
      disabled={loading || props.disabled}
      showSearch
      optionFilterProp="label"
    />
  );
};
