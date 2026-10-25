/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import {
  BaseLayoutModel,
  Icon,
  LayoutRoute,
  PinnedPluginListLite,
  stripModernClientPrefix,
  useApp,
  useSystemSettings,
} from '@nocobase/client-v2';
import { FlowEngineProvider, observer, useFlowEngine } from '@nocobase/flow-engine';
import { useRequest } from 'ahooks';
import { Alert, Button, Empty, Layout, Menu, Result, Space, Spin, Typography, theme } from 'antd';
import type { MenuProps } from 'antd';
import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Link, Navigate, Outlet, useLocation, useParams } from 'react-router-dom';
import { HubRouteRepository } from './HubRouteRepository';
import { createHubEngine } from './createHubEngine';
import { useT } from './locale';
import { findLandingRoute, flattenRoutes, hubLink, hubPath, type HubRoute } from './routes';

export const HUB_LAYOUT_UID = 'next-app-layout-model-v2';

function menuItems(
  routes: HubRoute[],
  appPath: string,
  getUrl: (path: string) => string,
  translate: (key: string) => string,
): MenuProps['items'] {
  return routes
    .filter((route) => !route.hidden && !route.hideInMenu && route.type !== 'tabs')
    .map((route) => {
      if (route.type === 'group')
        return {
          key: String(route.id),
          label: translate(route.title || ''),
          icon: route.icon ? <Icon type={route.icon} /> : undefined,
          title: route.tooltip ? translate(route.tooltip) : undefined,
          children: menuItems(route.children || [], appPath, getUrl, translate),
        };
      const target =
        route.type === 'link'
          ? hubLink(route.options?.url || '', appPath)
          : route.schemaUid
            ? hubPath(appPath, route.schemaUid)
            : undefined;
      if (!target) return null;
      const external = /^(https?:\/\/|mailto:|tel:)/i.test(target);
      const label = translate(route.title || '');
      return {
        key: route.schemaUid || String(route.id),
        icon: route.icon ? <Icon type={route.icon} /> : undefined,
        title: route.tooltip ? translate(route.tooltip) : undefined,
        label:
          external || route.options?.openInNewWindow ? (
            <a href={external ? target : getUrl(target)} target="_blank" rel="noopener noreferrer">
              {label}
            </a>
          ) : (
            <Link to={target}>{label}</Link>
          ),
      };
    });
}

const HubLayout = observer(({ model }: { model: BaseLayoutModel }) => {
  const app = useApp();
  const engine = useFlowEngine();
  const repository = engine.context.routeRepository as unknown as HubRouteRepository;
  const routes = useSyncExternalStore(repository.subscribe, repository.getSnapshot, repository.getSnapshot);
  const { appPath = '', name = '' } = useParams();
  const location = useLocation();
  const t = useT();
  const { token } = theme.useToken();
  const settings = useSystemSettings();
  const first = findLandingRoute(routes);
  const route = flattenRoutes(routes).find((item) => item.schemaUid === name || String(item.id) === name);
  const { loading, error, refresh } = useRequest(repository.ensureAccessibleLoaded, { refreshDeps: [repository] });
  const items = menuItems(
    routes,
    appPath,
    (path) => app.getRouteUrl(path),
    (key) => app.i18n.t(key, { ns: ['lm-next-app-routes', 'client'] }),
  );
  const isRoot = !name;
  const legacy = route?.type === 'page';
  const setContentElement = useCallback(
    (element: HTMLDivElement | null) => model.setLayoutContentElement(element),
    [model],
  );

  useEffect(() => {
    return () => model.setLayoutContentElement(null);
  }, [model]);
  if (loading) return <Spin />;
  if (error)
    return (
      <Alert
        type="error"
        showIcon
        message={t('Failed to load Hub routes')}
        action={<Button onClick={refresh}>{t('Retry')}</Button>}
      />
    );
  if (isRoot && first?.schemaUid) return <Navigate replace to={hubPath(appPath, first.schemaUid)} />;
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: token.colorBgContainer,
          paddingInline: 24,
        }}
      >
        <Space>
          {settings.data?.data?.logo?.url && <img src={settings.data.data.logo.url} alt="" style={{ height: 32 }} />}
          <Typography.Text strong>{settings.data?.data?.title || t('Next App')}</Typography.Text>
        </Space>
        <PinnedPluginListLite />
      </Layout.Header>
      <Layout>
        <Layout.Sider
          breakpoint="lg"
          collapsedWidth={0}
          theme="light"
          onBreakpoint={(broken) => model.setIsMobileLayout(broken)}
        >
          <nav aria-label={t('Next App routes')}>
            <Menu mode="inline" items={items} selectedKeys={[name]} />
          </nav>
        </Layout.Sider>
        <Layout.Content style={{ position: 'relative', minWidth: 0 }}>
          {isRoot ? (
            <Empty description={t('No modern pages are available')} />
          ) : legacy ? (
            <Result
              title={t('This page uses the legacy client')}
              extra={
                <Button
                  href={`${stripModernClientPrefix(app.getPublicPath())}hub/${encodeURIComponent(
                    appPath,
                  )}/${encodeURIComponent(name)}${location.search}${location.hash}`}
                >
                  {t('Open in legacy client')}
                </Button>
              }
            />
          ) : (
            <div
              ref={setContentElement}
              style={{ height: 'calc(100vh - 64px)', position: 'relative', overflow: 'auto' }}
            >
              <Outlet />
            </div>
          )}
        </Layout.Content>
      </Layout>
    </Layout>
  );
});

export class NextAppLayoutModel extends BaseLayoutModel {
  render() {
    return <HubLayout model={this} />;
  }
}

function HubRuntimeScope({ appPath }: { appPath: string }) {
  const app = useApp();
  const parent = useFlowEngine();
  const [scope] = useState(() => {
    const repository = new HubRouteRepository(app.apiClient, appPath);
    const engine = createHubEngine(parent, repository);
    return { engine, repository };
  });
  useEffect(
    () => () => {
      scope.repository.clear();
      scope.engine.removeModelWithSubModels(HUB_LAYOUT_UID);
      scope.engine.unlinkFromStack();
    },
    [scope],
  );
  return (
    <FlowEngineProvider engine={scope.engine}>
      <LayoutRoute layoutRouteName="hub" />
    </FlowEngineProvider>
  );
}

export function NextAppRuntime() {
  const { appPath = '' } = useParams();
  const app = useApp();
  const [authVersion, setAuthVersion] = useState(0);
  useEffect(() => {
    const changed = () => setAuthVersion((value) => value + 1);
    app.eventBus.addEventListener('auth:tokenChanged', changed);
    app.eventBus.addEventListener('auth:roleChanged', changed);
    return () => {
      app.eventBus.removeEventListener('auth:tokenChanged', changed);
      app.eventBus.removeEventListener('auth:roleChanged', changed);
    };
  }, [app]);
  return <HubRuntimeScope key={`${appPath}:${authVersion}`} appPath={appPath} />;
}

export function HubLegacyRedirect() {
  const location = useLocation();
  return (
    <Navigate
      replace
      to={`${location.pathname.replace(/^\/next-app(?=\/|$)/, '/hub')}${location.search}${location.hash}`}
    />
  );
}

export function HubTabsRedirect() {
  const { appPath = '', name = '', tabUid = '' } = useParams();
  const location = useLocation();
  return (
    <Navigate
      replace
      to={`${hubPath(appPath, name)}/tab/${encodeURIComponent(tabUid)}${location.search}${location.hash}`}
    />
  );
}
