import React, { Component as ReactComponent } from 'react';
import { useFieldSchema } from '@formily/react';
import { useApp } from '@nocobase/client';
import { Empty, Result, Button, Typography } from 'antd';
import { Outlet } from 'react-router-dom';
import { useT } from './locale';

const { Text } = Typography;

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
          extra={
            <Button onClick={() => this.setState({ error: null })}>
              Retry
            </Button>
          }
        />
      );
    }
    return this.props.children;
  }
}

function isRenderableComponent(comp: any): boolean {
  if (!comp) return false;
  if (comp === Outlet) return false;
  return true;
}

export const EmbedSettingsBlock = () => {
  const fieldSchema = useFieldSchema();
  const app = useApp();
  const t = useT();
  const pluginName = fieldSchema?.['x-component-props']?.pluginName;

  if (!pluginName) {
    return (
      <Empty description={
        <>
          <div>{t('Please select a plugin')}</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('Click the gear icon in the upper right corner to configure')}
          </Text>
        </>
      } />
    );
  }

  if (!app.pluginSettingsManager.has(pluginName)) {
    return <Empty description={t('Plugin not found or not authorized')} />;
  }

  const setting = app.pluginSettingsManager.getSetting(pluginName);

  if (!isRenderableComponent(setting?.Component)) {
    return <Empty description={t('This plugin has no embeddable settings page')} />;
  }

  const Comp = setting.Component;

  return (
    <EmbedErrorBoundary pluginName={pluginName}>
      <div style={{ minHeight: 200 }}>
        <Comp />
      </div>
    </EmbedErrorBoundary>
  );
};
