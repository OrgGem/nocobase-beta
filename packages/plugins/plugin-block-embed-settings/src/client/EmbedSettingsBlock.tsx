import React, { Component as ReactComponent } from 'react';
import { useFieldSchema } from '@formily/react';
import { useApp, SchemaComponentOptions } from '@nocobase/client';
import { Empty, Result, Button, Typography, Tabs } from 'antd';
import { css } from '@emotion/css';
import { useT } from './locale';
import {
  collectEmbeddablePluginTabs,
  EmbedSettingsTabOption,
  isRenderableSettingsComponent,
} from './EmbedSettingsPluginSelect';

const { Text } = Typography;

type EmbedSettingsBlockProps = {
  pluginName?: string;
  enabledTabKeys?: string[];
  dataSourceName?: string;
  collectionName?: string;
};

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

  const setting = app.pluginSettingsManager.getSetting(pluginName);
  const tabOptions = collectEmbeddablePluginTabs(app, pluginName);
  const selectedTabKeys = Array.isArray(enabledTabKeys) ? enabledTabKeys : tabOptions.map((tab) => tab.value);
  const enabledTabs = tabOptions.filter((tab) => selectedTabKeys.includes(tab.value));
  const tabsToRender =
    enabledTabs.length === 0 && Array.isArray(enabledTabKeys) && enabledTabKeys.length > 0 ? tabOptions : enabledTabs;

  if (!isRenderableSettingsComponent(setting?.Component) && tabOptions.length === 0) {
    return <Empty description={t('This plugin has no embeddable settings page')} />;
  }

  if (tabsToRender.length === 0) {
    return <Empty description={t('No tabs enabled')} />;
  }

  const renderComponent = (tab: EmbedSettingsTabOption) => {
    const Comp = tab.Component;
    return (
      <SchemaComponentOptions components={app.components}>
        <Comp {...tab.componentProps} dataSourceName={dataSourceName} collectionName={collectionName} embedded />
      </SchemaComponentOptions>
    );
  };

  return (
    <EmbedErrorBoundary pluginName={pluginName}>
      <div
        className={css`
          min-height: 200px;
          /* Force override the inline styles (like max-width 800px and padding 16px) 
             often set by other plugins' settings components */
          > div {
            max-width: 100% !important;
            padding: 0 !important;
          }
        `}
      >
        {tabsToRender.length === 1 ? (
          renderComponent(tabsToRender[0])
        ) : (
          <Tabs
            items={tabsToRender.map((tab) => ({
              key: tab.value,
              label: tab.label,
              children: renderComponent(tab),
            }))}
          />
        )}
      </div>
    </EmbedErrorBoundary>
  );
};
