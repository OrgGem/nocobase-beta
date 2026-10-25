/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { Component as ReactComponent, Suspense, useMemo } from 'react';
import { useApp } from '@nocobase/client-v2';
import { Empty, Result, Button, Typography, Tabs, Spin } from 'antd';
import { css } from '@emotion/css';
import { useT } from './locale';
import { collectEmbeddablePluginTabs, useEnabledEmbedSettingsPluginOptions } from './EmbedSettingsPluginSelect';
import type { EmbedSettingsBlockProps, EmbedSettingsTabOption } from './types';

const { Text } = Typography;

const embedBlockStyles = css`
  min-height: 200px;

  & > div,
  & > section,
  & > main {
    max-width: 100% !important;
    padding: 0 !important;
    margin: 0 !important;
  }
`;

class EmbedErrorBoundary extends ReactComponent<
  { children: React.ReactNode; pluginName: string; t: ReturnType<typeof useT> },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[EmbedSettingsBlock] Plugin "${this.props.pluginName}" render error:`, error);
  }

  render() {
    if (this.state.error) {
      return (
        <Result
          status="error"
          title={this.props.t('Unable to render embedded settings')}
          subTitle={this.state.error.message}
          extra={<Button onClick={() => this.setState({ error: null })}>{this.props.t('Retry')}</Button>}
        />
      );
    }
    return this.props.children;
  }
}

/**
 * Per-tab error boundary that catches rendering errors from individual embedded
 * plugin components (e.g., parseVariable null errors from missing VariablesProvider).
 */
class EmbedTabErrorBoundary extends ReactComponent<
  { children: React.ReactNode; tabLabel: string; t: ReturnType<typeof useT> },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[EmbedSettingsBlock] Tab "${this.props.tabLabel}" render error:`, error);
  }

  render() {
    if (this.state.error) {
      const msg = this.state.error.message || '';
      const isContextError = msg.includes('parseVariable') || msg.includes('Cannot read properties of null');
      return (
        <Result
          status="warning"
          title={this.props.t('Unable to render embedded settings')}
          subTitle={isContextError ? this.props.t('Open the full settings page to use this feature') : msg}
          extra={<Button onClick={() => this.setState({ error: null })}>{this.props.t('Retry')}</Button>}
        />
      );
    }
    return this.props.children;
  }
}

export const EmbedSettingsBlock: React.FC<EmbedSettingsBlockProps> = ({
  pluginName: pluginNameProp,
  enabledTabKeys: enabledTabKeysProp,
  dataSourceName: dataSourceNameProp,
  collectionName: collectionNameProp,
} = {}) => {
  const app = useApp();
  const t = useT();
  const { loading, options } = useEnabledEmbedSettingsPluginOptions();
  const pluginName = pluginNameProp;
  const enabledTabKeys = enabledTabKeysProp;
  const dataSourceName = dataSourceNameProp;
  const collectionName = collectionNameProp;

  if (!pluginName) {
    return (
      <Empty
        description={
          <>
            <div>{t('Please select a plugin')}</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('Click the gear icon in the upper right corner to configure')}
            </Text>
          </>
        }
      />
    );
  }

  if (loading) return <Spin />;
  if (!options.some((option) => option.value === pluginName))
    return <Empty description={t('Plugin not found or not authorized')} />;

  if (!app.pluginSettingsManager.has(pluginName)) {
    return <Empty description={t('Plugin not found or not authorized')} />;
  }

  const tabOptions = collectEmbeddablePluginTabs(app, pluginName);
  const selectedTabKeys = Array.isArray(enabledTabKeys) ? enabledTabKeys : tabOptions.map((tab) => tab.value);
  const enabledTabs = tabOptions.filter((tab) => selectedTabKeys.includes(tab.value));
  const tabsToRender = enabledTabs;

  if (tabOptions.length === 0) {
    return <Empty description={t('This plugin has no embeddable settings page')} />;
  }

  if (tabsToRender.length === 0) {
    return <Empty description={t('No tabs enabled')} />;
  }

  return (
    <EmbedErrorBoundary pluginName={pluginName} t={t}>
      <div className={embedBlockStyles}>
        {tabsToRender.length === 1 ? (
          <EmbedTabErrorBoundary tabLabel={tabsToRender[0].label} t={t}>
            <EmbedTabContent tab={tabsToRender[0]} dataSourceName={dataSourceName} collectionName={collectionName} />
          </EmbedTabErrorBoundary>
        ) : (
          <Tabs
            items={tabsToRender.map((tab) => ({
              key: tab.value,
              label: tab.label,
              children: (
                <EmbedTabErrorBoundary tabLabel={tab.label} t={t}>
                  <EmbedTabContent tab={tab} dataSourceName={dataSourceName} collectionName={collectionName} />
                </EmbedTabErrorBoundary>
              ),
            }))}
          />
        )}
      </div>
    </EmbedErrorBoundary>
  );
};

const EmbedTabContent: React.FC<{
  tab: EmbedSettingsTabOption;
  dataSourceName?: string;
  collectionName?: string;
}> = ({ tab, dataSourceName, collectionName }) => {
  const app = useApp();
  const Comp = useMemo<React.ComponentType<Record<string, unknown>>>(() => {
    if (typeof tab.Component === 'string') return app.getComponent(tab.Component) || (() => null);
    if (tab.Component) return tab.Component;
    if (tab.componentLoader)
      return React.lazy(async () => {
        const loaded = await tab.componentLoader();
        const component = loaded && typeof loaded === 'object' && 'default' in loaded ? loaded.default : loaded;
        const resolved = typeof component === 'string' ? app.getComponent(component) : component;
        return { default: (resolved || (() => null)) as React.ComponentType<Record<string, unknown>> };
      });
    return () => null;
  }, [app, tab]);

  return (
    <Suspense fallback={<Spin />}>
      <Comp {...tab.componentProps} dataSourceName={dataSourceName} collectionName={collectionName} embedded />
    </Suspense>
  );
};
