import React, { Component as ReactComponent, Suspense, useMemo } from 'react';
import { useFieldSchema } from '@formily/react';
import { useApp } from '@nocobase/client-v2';
import { Empty, Result, Button, Typography, Tabs, Spin } from 'antd';
import { css } from '@emotion/css';
import { useT } from './locale';
import { collectEmbeddablePluginTabs } from './EmbedSettingsPluginSelect';
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
  { children: React.ReactNode; pluginName: string },
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
          title={`Plugin "${this.props.pluginName}" render failed`}
          subTitle={this.state.error.message}
          extra={<Button onClick={() => this.setState({ error: null })}>Retry</Button>}
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
  { children: React.ReactNode; tabLabel: string },
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
      const isContextError =
        msg.includes('parseVariable') ||
        msg.includes('Cannot read properties of null');
      return (
        <Result
          status="warning"
          title={`"${this.props.tabLabel}" encountered a rendering issue`}
          subTitle={
            isContextError
              ? 'This settings page requires additional context providers not available in embedded mode. Try opening the full settings page instead.'
              : msg
          }
          extra={<Button onClick={() => this.setState({ error: null })}>Retry</Button>}
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
  const fieldSchema = useFieldSchema();
  const app = useApp();
  const t = useT();
  const pluginName = pluginNameProp || fieldSchema?.['x-component-props']?.pluginName;
  const enabledTabKeys = enabledTabKeysProp || fieldSchema?.['x-component-props']?.enabledTabKeys;
  const dataSourceName = dataSourceNameProp || fieldSchema?.['x-component-props']?.dataSourceName;
  const collectionName = collectionNameProp || fieldSchema?.['x-component-props']?.collectionName;

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

  if (!app.pluginSettingsManager.has(pluginName)) {
    return <Empty description={t('Plugin not found or not authorized')} />;
  }

  const tabOptions = collectEmbeddablePluginTabs(app, pluginName);
  const selectedTabKeys = Array.isArray(enabledTabKeys) ? enabledTabKeys : tabOptions.map((tab) => tab.value);
  const enabledTabs = tabOptions.filter((tab) => selectedTabKeys.includes(tab.value));
  const tabsToRender =
    enabledTabs.length === 0 && Array.isArray(enabledTabKeys) && enabledTabKeys.length > 0 ? tabOptions : enabledTabs;

  if (tabOptions.length === 0) {
    return <Empty description={t('This plugin has no embeddable settings page')} />;
  }

  if (tabsToRender.length === 0) {
    return <Empty description={t('No tabs enabled')} />;
  }

  return (
    <EmbedErrorBoundary pluginName={pluginName}>
      <div className={embedBlockStyles}>
        {tabsToRender.length === 1 ? (
          <EmbedTabErrorBoundary tabLabel={tabsToRender[0].label}>
            <EmbedTabContent tab={tabsToRender[0]} dataSourceName={dataSourceName} collectionName={collectionName} />
          </EmbedTabErrorBoundary>
        ) : (
          <Tabs
            items={tabsToRender.map((tab) => ({
              key: tab.value,
              label: tab.label,
              children: (
                <EmbedTabErrorBoundary tabLabel={tab.label}>
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
  const Comp = useMemo<React.ComponentType<Record<string, unknown>>>(() => {
    if (tab.Component) return tab.Component;
    if (tab.componentLoader) return React.lazy(tab.componentLoader);
    return () => null;
  }, [tab.Component, tab.componentLoader]);

  return (
    <Suspense fallback={<Spin />}>
      <Comp {...tab.componentProps} dataSourceName={dataSourceName} collectionName={collectionName} embedded />
    </Suspense>
  );
};
