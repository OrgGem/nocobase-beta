import React from 'react';
import { collectEmbeddablePlugins, collectEmbeddablePluginTabs } from '../EmbedSettingsPluginSelect';

describe('EmbedSettingsPluginSelect', () => {
  it('collects string labels when v2 settings titles are React nodes', () => {
    const settings = {
      demo: {
        name: 'demo',
        title: <span>Demo plugin</span>,
        children: [
          {
            name: 'demo.index',
            key: 'index',
            title: <span>Overview</span>,
            Component: () => null,
          },
        ],
      },
    };
    const app = {
      i18n: { t: (key: string) => key },
      pluginSettingsManager: {
        getList: () => [settings.demo],
        has: (name: string) => Boolean(settings[name]),
        get: (name: string) => settings[name],
      },
    };

    expect(collectEmbeddablePlugins(app)).toEqual([{ value: 'demo', label: 'Demo plugin' }]);
    expect(collectEmbeddablePluginTabs(app, 'demo')).toMatchObject([{ value: 'demo.index', label: 'Overview' }]);
  });
});
