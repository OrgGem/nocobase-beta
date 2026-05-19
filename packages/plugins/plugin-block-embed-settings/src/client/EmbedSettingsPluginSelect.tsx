import React, { useEffect, useMemo, useState } from 'react';
import { Select } from 'antd';
import { useAPIClient, useApp, useCompile } from '@nocobase/client';
import { Outlet } from 'react-router-dom';

export type EmbedSettingsPluginOption = { value: string; label: string };
export type EmbedSettingsTabOption = { value: string; label: string; Component: any; componentProps?: any };

export function isRenderableSettingsComponent(comp: any): boolean {
  if (!comp) return false;
  if (comp === Outlet) return false;
  return true;
}

function toLabel(value: any, fallback: string, compile?: (value: any) => string) {
  const label = typeof compile === 'function' ? compile(value || fallback) : value || fallback;
  return typeof label === 'string' ? label : fallback;
}

function collectRenderableSettingPages(
  app: any,
  setting: any,
  compile?: (value: any) => string,
  parentLabels: string[] = [],
): EmbedSettingsTabOption[] {
  if (!setting) {
    return [];
  }

  const explicitTabs = collectExplicitEmbedTabs(setting, compile);
  if (explicitTabs.length > 0) {
    return explicitTabs;
  }

  const currentLabel = toLabel(setting.title, setting.name, compile);
  const labels = currentLabel ? [...parentLabels, currentLabel] : parentLabels;
  const children = Object.keys(setting.children || {})
    .sort((a, b) => a.localeCompare(b))
    .map((key) => setting.children[key])
    .filter((child: any) => child?.name && app.pluginSettingsManager.has(child.name))
    .sort((a: any, b: any) => (a.sort || 0) - (b.sort || 0));
  const childTabs = children.flatMap((child: any) => collectRenderableSettingPages(app, child, compile, labels));

  if (childTabs.length > 0) {
    return childTabs;
  }

  if (isRenderableSettingsComponent(setting.Component)) {
    return [
      {
        value: setting.name,
        label: labels.length > 1 ? labels.slice(1).join(' / ') : currentLabel || setting.name,
        Component: setting.Component,
      },
    ];
  }

  return [];
}

function collectExplicitEmbedTabs(setting: any, compile?: (value: any) => string): EmbedSettingsTabOption[] {
  const tabs =
    typeof setting?.embedSettings?.tabs === 'function'
      ? setting.embedSettings.tabs(setting)
      : setting?.embedSettings?.tabs;
  if (!Array.isArray(tabs)) {
    return [];
  }

  return tabs.reduce((result: EmbedSettingsTabOption[], tab: any, index: number) => {
    const key = tab?.value || tab?.key || tab?.name || String(index + 1);
    const Component = tab?.Component || tab?.component || setting.Component;
    if (!key || !isRenderableSettingsComponent(Component)) {
      return result;
    }
    result.push({
      value: tab?.value || `${setting.name}.${key}`,
      label: toLabel(tab?.title || tab?.label, key, compile),
      Component,
      componentProps: tab?.componentProps || tab?.props,
    });
    return result;
  }, []);
}

export function collectEmbeddablePluginTabs(
  app: any,
  pluginName?: string,
  compile?: (value: any) => string,
): EmbedSettingsTabOption[] {
  if (!pluginName || !app.pluginSettingsManager.has(pluginName)) return [];

  const setting = app.pluginSettingsManager.getSetting(pluginName);
  return collectRenderableSettingPages(app, setting, compile);
}

export function collectEmbeddablePlugins(app: any, compile?: (value: any) => string): EmbedSettingsPluginOption[] {
  const results: { value: string; label: string }[] = [];
  const settings = (app.pluginSettingsManager as any).settings as Record<string, any>;

  for (const [key, setting] of Object.entries(settings || {})) {
    if (!app.pluginSettingsManager.has(key)) continue;
    if (setting.topLevelName !== key) continue;
    if (collectEmbeddablePluginTabs(app, key, compile).length === 0) continue;
    if (key.includes(':')) continue;

    results.push({ value: key, label: toLabel(setting.title, key, compile) });
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
