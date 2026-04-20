/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * NextAppInternalLayout — A simplified version of InternalAdminLayout for the sub-router.
 *
 * Key differences from InternalAdminLayout:
 * 1. convertRoutesToLayout uses "/" prefix instead of "/admin/" (relative to sub-router basename)
 * 2. NavigateToDefaultPage redirects "/" → "/{firstPageUid}" within the sub-router
 * 3. No KeepAlive (simplified) — can be added later if needed
 */
import React, { FC, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import ProLayout, { RouteContext, RouteContextType } from '@ant-design/pro-layout';
import { theme as antdTheme, ConfigProvider, Grid, Result } from 'antd';
import { css } from '@emotion/css';
import { createGlobalStyle } from 'antd-style';
import { HighlightOutlined } from '@ant-design/icons';
import {
  DndContext,
  Icon,
  PinnedPluginList,
  useDesignable,
  useGlobalTheme,
  useMenuDragEnd,
  useSchemaInitializerRender,
  useSystemSettings,
  useToken,
  NocoBaseDesktopRouteType,
  findFirstPageRoute,
} from '@nocobase/client';
import { useMenuTranslation } from '@nocobase/client';
import { useNextAppAllAccessRoutes, NextAppRoutesRequestProvider } from './nextAppRoutesContext';

// ---------- convertRoutesToLayout (custom prefix-free version) ----------

/**
 * Same as core convertRoutesToLayout but uses "/" prefix
 * (paths relative to sub-router basename) instead of hardcoded "/admin/"
 */
function convertRoutesToLayout(routes: any[], { designable, parentRoute, isMobile, t, depth = 0 }: any) {
  if (!routes || !Array.isArray(routes)) return [];

  const result: any[] = routes
    .map((item: any) => {
      if (!item || typeof item !== 'object') return null;

      const name = t(item.title);
      const icon = item.icon ? <Icon type={item.icon} /> : null;

      if (item.type === NocoBaseDesktopRouteType.link) {
        return {
          name,
          icon,
          path: '/',
          hideInMenu: item.hideInMenu,
          _route: item,
          _parentRoute: parentRoute,
          _depth: depth,
        };
      }

      if (item.type === NocoBaseDesktopRouteType.page || item.type === NocoBaseDesktopRouteType.flowPage) {
        return {
          name,
          icon,
          // Use "/" prefix — relative to sub-router basename
          path: `/${item.schemaUid}`,
          redirect: `/${item.schemaUid}`,
          hideInMenu: item.hideInMenu,
          _route: item,
          _parentRoute: parentRoute,
          _depth: depth,
        };
      }

      if (item.type === NocoBaseDesktopRouteType.group) {
        const itemChildren = Array.isArray(item.children) ? item.children : [];
        const children =
          convertRoutesToLayout(itemChildren, {
            designable,
            parentRoute: item,
            depth: depth + 1,
            isMobile,
            t,
          }) || [];

        const firstChild = findFirstPageRoute(itemChildren);
        const groupRoute: any = {
          name,
          icon,
          path: `/${item.id}`,
          redirect: children.length > 0 ? `/${firstChild?.schemaUid || item.id}` : undefined,
          hideInMenu: item.hideInMenu,
          _route: item,
          _depth: depth,
        };

        if (children.length > 0) {
          groupRoute.routes = children;
        }

        return groupRoute;
      }

      return null;
    })
    .filter(Boolean);

  return result;
}

// ---------- Layout styles ----------

const layoutContentClass = css`
  display: flex;
  flex-direction: column;
  position: relative;
  height: calc(100vh - var(--nb-header-height));
  > div {
    position: relative;
  }
`;

const resetStyle = css`
  .ant-layout-sider-children {
    margin-inline-end: 0 !important;
  }
  .ant-layout-header.ant-pro-layout-header {
    border-block-end: none !important;
  }
`;

const contentStyle = {
  paddingBlock: 0,
  paddingInline: 0,
};

const pageContentStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
};

const rootStyle: React.CSSProperties = { display: 'flex', height: '100vh' };
const appContainerStyle: React.CSSProperties = {
  flex: 1,
  transform: 'translateZ(0)',
  overflow: 'hidden',
  scrollPaddingTop: 'var(--nb-header-height)',
};

// ---------- Layout sub-components ----------

const ShowTipWhenNoPages = () => {
  const { allAccessRoutes } = useNextAppAllAccessRoutes();
  const { designable } = useDesignable();
  const { token } = useToken();
  const { t } = useTranslation();
  const location = useLocation();

  if (allAccessRoutes.length === 0 && !designable && (location.pathname === '/' || location.pathname === '')) {
    return (
      <Result
        icon={<HighlightOutlined style={{ fontSize: '8em', color: token.colorText }} />}
        title={t('No pages yet, please configure first')}
        subTitle={t(`Click the "UI Editor" icon in the upper right corner to enter the UI Editor mode`)}
      />
    );
  }

  return null;
};

const LayoutContent = () => {
  return (
    <div className={layoutContentClass}>
      <div style={pageContentStyle}>
        <Outlet />
        <ShowTipWhenNoPages />
      </div>
    </div>
  );
};

const NocoBaseLogo = () => {
  const result = useSystemSettings();
  const { token } = useToken();
  const { t } = useTranslation('lm-collections');
  const fontSizeStyle = useMemo(() => ({ fontSize: token.fontSizeHeading3 }), [token.fontSizeHeading3]);

  const logoClass = css`
    height: var(--nb-header-height);
    margin-right: 4px;
    display: inline-flex;
    flex-shrink: 0;
    color: #fff;
    padding: 0;
    align-items: center;
    width: auto;
    min-width: 168px;
  `;

  const imgClass = css`
    object-fit: contain;
    width: 100%;
    height: 100%;
  `;

  const titleClass = css`
    width: 100%;
    height: 100%;
    font-weight: 500;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `;

  const hasLogo = result?.data?.data?.logo?.url;
  const logo = hasLogo ? (
    <img className={imgClass} src={result?.data?.data?.logo?.url} />
  ) : (
    <span style={fontSizeStyle} className={titleClass}>
      {t(result?.data?.data?.title)}
    </span>
  );

  return <div className={logoClass}>{result?.loading ? null : logo}</div>;
};

const actionsRender = () => {
  return [<PinnedPluginList key="actions" />];
};

const NavigateToDefaultPage: FC = ({ children }) => {
  const { allAccessRoutes } = useNextAppAllAccessRoutes();
  const location = useLocation();
  const defaultPageUid = findFirstPageRoute(allAccessRoutes as any[])?.schemaUid;

  return (
    <>
      {children}
      {defaultPageUid && (location.pathname === '/' || location.pathname === '') && (
        <Navigate replace to={`/${defaultPageUid}`} />
      )}
    </>
  );
};

const GlobalStyle = () => {
  const { token } = useToken();
  const El: FC<any> = useMemo(() => {
    if (token.globalStyle) {
      return createGlobalStyle`${token.globalStyle}`;
    }
    return () => null;
  }, [token.globalStyle]);

  return <El />;
};

// ---------- Main Layout Component ----------

export const NextAppInternalLayout = (props: any) => {
  const { allAccessRoutes } = useNextAppAllAccessRoutes();
  const { designable: _designable } = useDesignable();
  const screens = Grid.useBreakpoint();
  const isMobileViewport =
    screens.md === false || (screens.md === undefined && typeof window !== 'undefined' && window.innerWidth < 768);
  const location = useLocation();
  const { onDragEnd } = useMenuDragEnd();
  const { token } = useToken();
  const [collapsed, setCollapsed] = useState(isMobileViewport);
  const { t } = useMenuTranslation();
  const designable = isMobileViewport ? false : _designable;

  const route = useMemo(() => {
    const children = convertRoutesToLayout(allAccessRoutes, { designable, isMobile: isMobileViewport, t });
    return {
      path: '/',
      children: Array.isArray(children) ? children : [],
    };
  }, [allAccessRoutes, designable, isMobileViewport, t]);

  const layoutToken = useMemo(() => {
    return {
      header: {
        colorBgHeader: token.colorBgHeader,
        colorTextMenu: token.colorTextHeaderMenu,
        colorTextMenuSelected: token.colorTextHeaderMenuActive,
        colorTextMenuActive: token.colorTextHeaderMenuHover,
        colorBgMenuItemHover: token.colorBgHeaderMenuHover,
        colorBgMenuItemSelected: token.colorBgHeaderMenuActive,
        heightLayoutHeader: 46,
        colorHeaderTitle: token.colorTextHeaderMenu,
      },
      sider: {
        colorMenuBackground: token.colorBgSider,
        colorTextMenu: token.colorTextSiderMenu,
        colorTextMenuSelected: token.colorTextSiderMenuActive,
        colorBgMenuItemSelected: token.colorBgSiderMenuActive,
        colorBgMenuItemActive: token.colorBgSiderMenuActive,
        colorBgMenuItemHover: token.colorBgSiderMenuHover,
      },
      bgLayout: token.colorBgLayout,
    };
  }, [token]);

  const { theme } = useGlobalTheme();

  const onCollapse = useCallback((collapsed: boolean) => {
    setCollapsed(collapsed);
  }, []);

  return (
    <div style={rootStyle}>
      <div id="nocobase-nextapp-container" style={appContainerStyle}>
        <DndContext onDragEnd={onDragEnd}>
          <ProLayout
            {...props}
            contentStyle={contentStyle}
            siderWidth={token.siderWidth || 200}
            className={resetStyle}
            location={location}
            route={route}
            actionsRender={actionsRender}
            logo={<NocoBaseLogo />}
            title={''}
            layout="mix"
            splitMenus
            token={layoutToken}
            onCollapse={onCollapse}
            collapsed={collapsed}
          >
            <RouteContext.Consumer>
              {() => {
                return (
                  <ConfigProvider theme={theme}>
                    <GlobalStyle />
                    <LayoutContent />
                  </ConfigProvider>
                );
              }}
            </RouteContext.Consumer>
          </ProLayout>
        </DndContext>
      </div>
    </div>
  );
};

/**
 * Full layout wrapper with providers + auto-redirect
 */
export const NextAppLayout = (props: any) => {
  return (
    <NextAppRoutesRequestProvider>
      <NavigateToDefaultPage>
        <NextAppInternalLayout {...props} />
      </NavigateToDefaultPage>
    </NextAppRoutesRequestProvider>
  );
};

export default NextAppLayout;
