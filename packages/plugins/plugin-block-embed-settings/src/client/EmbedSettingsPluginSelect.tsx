import React, { useEffect, useMemo, useState } from 'react';
import { Select } from 'antd';
import { useApp } from '@nocobase/client-v2';

export type EmbedSettingsPluginOption = { value: string; label: string };
export type EmbedSettingsTabOption = {
  value: string;
  label: string;
  componentLoader?: () => Promise<{ default: React.ComponentType<any> }>;
  Component?: React.ComponentType<any>;
  componentProps?: any;
};

const TEMPLATE_RE = /\{\{\s*t\(\s*(['"])(.*?)\1\s*(?:,\s*(\{.*?\}))?\)\s*\}\}/;

/**
 * Resolve a possibly-`{{t("...")}}`-wrapped label to a display string using the
 * v2 app i18n instance.
 */
function compileLabel(app: any, value: any, fallback: string): string {
  if (typeof value !== 'string') return value || fallback;
  const match = value.match(TEMPLATE_RE);
  if (!match) return value || fallback;
  const key = match[2];
  let options: Record<string, any> | undefined;
  if (match[3]) {
    try {
      options = JSON.parse(match[3].replace(/(\w+):/g, '"$1":').replace(/'/g, '"'));
    } catch {
      options = undefined;
    }
  }
  const translated = app?.i18n?.t?.(key, options);
  return typeof translated === 'string' && translated ? translated : fallback;
}

function isRenderablePage(page: any): boolean {
  if (!page) return false;
  return Boolean(page.Component || page.componentLoader);
}

/**
 * Collect the embeddable settings tabs for a given top-level settings menu key,
 * using the v2 flat `pluginSettingsManager.getList()` snapshot.
 */
export function collectEmbeddablePluginTabs(app: any, pluginName?: string): EmbedSettingsTabOption[] {
  if (!pluginName || !app.pluginSettingsManager.has(pluginName)) return [];
  const setting = app.pluginSettingsManager.get(pluginName);
  if (!setting) return [];

  const children = Array.isArray(setting.children) ? setting.children.filter(isRenderablePage) : [];
  if (children.length > 0) {
    return children.map((child: any) => ({
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
export function collectEmbeddablePlugins(app: any): EmbedSettingsPluginOption[] {
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

export function normalizeAllowedRecords(data: any): any[] {
  const records = data?.data?.data || data?.data || data || [];
  return Array.isArray(records) ? records : [];
}

export function useEnabledEmbedSettingsPluginOptions() {
  const app = useApp();
  const api = app.apiClient;
  const [records, setRecords] = useState<any[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .request({
        url: 'embedAllowedPlugins:list',
        params: { filter: { enabled: true }, pageSize: 200 },
      })
      .then(({ data }: any) => {
        if (!cancelled) setRecords(normalizeAllowedRecords(data));
      })
      .catch(() => {
        if (!cancelled) setRecords([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const options = useMemo(() => {
    if (!records) return [];
    const allowedTitles = new Map(records.map((record: any) => [record.pluginName, record.title]));
    return collectEmbeddablePlugins(app)
      .filter((option) => allowedTitles.has(option.value))
      .map((option) => ({
        ...option,
        label: allowedTitles.get(option.value) || option.label,
      }));
  }, [app, records]);

  return {
    loading: records === null,
    options,
  };
}

export const EmbedSettingsPluginSelect = (props: any) => {
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
