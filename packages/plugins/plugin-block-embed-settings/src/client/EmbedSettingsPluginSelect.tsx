import React, { useEffect, useMemo, useState } from 'react';
import { Select } from 'antd';
import { useAPIClient, useApp, useCompile } from '@nocobase/client';
import { Outlet } from 'react-router-dom';

export type EmbedSettingsPluginOption = { value: string; label: string };

export function collectEmbeddablePlugins(app: any, compile?: (value: any) => string): EmbedSettingsPluginOption[] {
  const results: { value: string; label: string }[] = [];
  const settings = (app.pluginSettingsManager as any).settings as Record<string, any>;

  for (const [key, setting] of Object.entries(settings || {})) {
    if (!app.pluginSettingsManager.has(key)) continue;
    if (!setting.Component || setting.Component === Outlet) continue;
    if (key.includes(':')) continue;

    const rawLabel = setting.title || key;
    const label = typeof compile === 'function' ? compile(rawLabel) : rawLabel;
    results.push({ value: key, label: typeof label === 'string' ? label : key });
  }

  return results.sort((a, b) => a.label.localeCompare(b.label));
}

export function normalizeAllowedRecords(data: any): any[] {
  const records = data?.data?.data || data?.data || data || [];
  return Array.isArray(records) ? records : [];
}

export function useEnabledEmbedSettingsPluginOptions() {
  const app = useApp();
  const api = useAPIClient();
  const compile = useCompile();
  const [records, setRecords] = useState<any[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .request({
        url: 'embedAllowedPlugins:list',
        params: { filter: { enabled: true }, pageSize: 200 },
      })
      .then(({ data }) => {
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
    return collectEmbeddablePlugins(app, compile)
      .filter((option) => allowedTitles.has(option.value))
      .map((option) => ({
        ...option,
        label: allowedTitles.get(option.value) || option.label,
      }));
  }, [app, compile, records]);

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
