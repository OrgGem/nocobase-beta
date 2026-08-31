import React from 'react';
import {
  collectEmbeddablePlugins,
  collectEmbeddablePluginTabs,
  normalizeAllowedRecords,
} from '../EmbedSettingsPluginSelect';

const makeApp = (settings: Record<string, any>) => ({
  i18n: { t: (key: string) => key },
  pluginSettingsManager: {
    getList: () => Object.values(settings),
    has: (name: string) => Boolean(settings[name]),
    get: (name: string) => settings[name],
  },
});

describe('collectEmbeddablePluginTabs', () => {
  it('returns empty array when pluginName is undefined', () => {
    const app = makeApp({});
    expect(collectEmbeddablePluginTabs(app, undefined)).toEqual([]);
  });

  it('returns empty array when plugin is not registered', () => {
    const app = makeApp({});
    expect(collectEmbeddablePluginTabs(app, 'nonexistent')).toEqual([]);
  });

  it('returns empty array when plugin has no Component or componentLoader', () => {
    const app = makeApp({
      demo: { name: 'demo', title: 'Demo' },
    });
    expect(collectEmbeddablePluginTabs(app, 'demo')).toEqual([]);
  });

  it('returns single tab for plugin with direct Component', () => {
    const Comp = () => null;
    const app = makeApp({
      demo: { name: 'demo', title: 'Demo Plugin', Component: Comp },
    });
    const tabs = collectEmbeddablePluginTabs(app, 'demo');
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ value: 'demo', label: 'Demo Plugin', Component: Comp });
  });

  it('returns single tab for plugin with componentLoader', () => {
    const loader = () => Promise.resolve({ default: () => null });
    const app = makeApp({
      demo: { name: 'demo', title: 'Demo Plugin', componentLoader: loader },
    });
    const tabs = collectEmbeddablePluginTabs(app, 'demo');
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ value: 'demo', label: 'Demo Plugin', componentLoader: loader });
  });

  it('returns children tabs when children array has renderable pages', () => {
    const Comp1 = () => null;
    const Comp2 = () => null;
    const app = makeApp({
      demo: {
        name: 'demo',
        title: 'Demo',
        children: [
          { name: 'demo.tab1', key: 'tab1', title: 'Tab 1', Component: Comp1 },
          { name: 'demo.tab2', key: 'tab2', title: 'Tab 2', Component: Comp2 },
        ],
      },
    });
    const tabs = collectEmbeddablePluginTabs(app, 'demo');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toMatchObject({ value: 'demo.tab1', label: 'Tab 1' });
    expect(tabs[1]).toMatchObject({ value: 'demo.tab2', label: 'Tab 2' });
  });

  it('filters out non-renderable children', () => {
    const Comp = () => null;
    const app = makeApp({
      demo: {
        name: 'demo',
        title: 'Demo',
        children: [
          { name: 'demo.tab1', key: 'tab1', title: 'Tab 1', Component: Comp },
          { name: 'demo.tab2', key: 'tab2', title: 'Tab 2' }, // no Component
        ],
      },
    });
    const tabs = collectEmbeddablePluginTabs(app, 'demo');
    expect(tabs).toHaveLength(1);
    expect(tabs[0].value).toBe('demo.tab1');
  });

  it('resolves React node labels via stringifyLabel', () => {
    const app = makeApp({
      demo: {
        name: 'demo',
        title: <span>Demo Plugin</span>,
        children: [{ name: 'demo.index', key: 'index', title: <span>Overview</span>, Component: () => null }],
      },
    });
    const tabs = collectEmbeddablePluginTabs(app, 'demo');
    expect(tabs[0].label).toBe('Overview');
  });

  it('resolves {{t("...")}} template labels', () => {
    const app = makeApp({
      demo: {
        name: 'demo',
        title: '{{t("Demo Title")}}',
        Component: () => null,
      },
    });
    const tabs = collectEmbeddablePluginTabs(app, 'demo');
    expect(tabs[0].label).toBe('Demo Title');
  });

  it('falls back to key when title is missing', () => {
    const app = makeApp({
      demo: {
        name: 'demo',
        children: [{ name: 'demo.settings', key: 'settings', Component: () => null }],
      },
    });
    const tabs = collectEmbeddablePluginTabs(app, 'demo');
    expect(tabs[0].label).toBe('settings');
  });
});

describe('collectEmbeddablePlugins', () => {
  it('returns empty array when no plugins registered', () => {
    const app = makeApp({});
    expect(collectEmbeddablePlugins(app)).toEqual([]);
  });

  it('skips plugins with colon in name (sub-settings)', () => {
    const app = makeApp({
      'parent:child': { name: 'parent:child', title: 'Sub', Component: () => null },
      demo: { name: 'demo', title: 'Demo', Component: () => null },
    });
    const plugins = collectEmbeddablePlugins(app);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].value).toBe('demo');
  });

  it('skips plugins without renderable pages', () => {
    const app = makeApp({
      empty: { name: 'empty', title: 'Empty' },
      demo: { name: 'demo', title: 'Demo', Component: () => null },
    });
    const plugins = collectEmbeddablePlugins(app);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].value).toBe('demo');
  });

  it('sorts results alphabetically by label', () => {
    const app = makeApp({
      zebra: { name: 'zebra', title: 'Zebra Plugin', Component: () => null },
      alpha: { name: 'alpha', title: 'Alpha Plugin', Component: () => null },
    });
    const plugins = collectEmbeddablePlugins(app);
    expect(plugins[0].label).toBe('Alpha Plugin');
    expect(plugins[1].label).toBe('Zebra Plugin');
  });

  it('handles React node titles in plugin list', () => {
    const app = makeApp({
      demo: { name: 'demo', title: <span>Demo Plugin</span>, Component: () => null },
    });
    const plugins = collectEmbeddablePlugins(app);
    expect(plugins[0].label).toBe('Demo Plugin');
  });
});

describe('normalizeAllowedRecords', () => {
  it('returns empty array for undefined', () => {
    expect(normalizeAllowedRecords(undefined)).toEqual([]);
  });

  it('returns empty array for null', () => {
    expect(normalizeAllowedRecords(null)).toEqual([]);
  });

  it('returns array as-is', () => {
    const records = [{ id: 1, pluginName: 'demo', title: 'Demo', enabled: true }];
    expect(normalizeAllowedRecords(records)).toEqual(records);
  });

  it('extracts from { data: [...] } shape', () => {
    const records = [{ id: 1, pluginName: 'demo', title: 'Demo', enabled: true }];
    expect(normalizeAllowedRecords({ data: records })).toEqual(records);
  });

  it('extracts from { data: { data: [...] } } shape', () => {
    const records = [{ id: 1, pluginName: 'demo', title: 'Demo', enabled: true }];
    expect(normalizeAllowedRecords({ data: { data: records } })).toEqual(records);
  });

  it('returns empty array for non-array data', () => {
    expect(normalizeAllowedRecords({ data: 'invalid' })).toEqual([]);
  });
});
