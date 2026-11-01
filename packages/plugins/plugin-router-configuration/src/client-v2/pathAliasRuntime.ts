/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import {
  AdminLayoutMenuItemModel,
  AdminLayoutModel,
  AdminLayoutRouteCoordinator,
  findFirstV2LandingRoute,
  joinAdminLayoutRoutePath,
  resolveAdminRouteRuntimeTarget,
  toRouterNavigationPath,
  type LayoutRouteLike,
  type NocoBaseDesktopRoute,
} from '@nocobase/client-v2';
import type { useApp } from '@nocobase/client-v2';
import type { ViewParam } from '@nocobase/flow-engine';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { UNSAFE_RouteContext, useLocation, useMatches, useNavigate } from 'react-router-dom';

type App = ReturnType<typeof useApp>;
type AliasRouteRepository = {
  listAccessible?: () => NocoBaseDesktopRoute[];
  ensureAccessibleLoaded?: () => Promise<unknown>;
  isAccessibleLoaded?: () => boolean;
  activateLayout?: (layout?: { uid?: string }) => () => void;
  subscribe?: (subscriber: () => void) => () => void;
};
type RouteWithPathAlias = NocoBaseDesktopRoute & {
  options?: NocoBaseDesktopRoute['options'] & { pathAlias?: unknown };
};
type RouteLikeForCoordinator = Parameters<AdminLayoutRouteCoordinator['syncRoute']>[0];
type RouterTo = Parameters<NonNullable<App['router']['router']>['navigate']>[0];

const patchedRouterManagers = new WeakSet<object>();
const patchedRouters = new WeakSet<object>();
const previousAliasHistoryByEngine = new WeakMap<object, Map<string, Map<string, string>>>();
const maxPreviousAliasHistorySize = 128;

const getPathAlias = (route: NocoBaseDesktopRoute | undefined) => {
  const value = (route as RouteWithPathAlias | undefined)?.options?.pathAlias;
  return typeof value === 'string' ? value : undefined;
};

const flattenRoutes = (routes: NocoBaseDesktopRoute[] | undefined): NocoBaseDesktopRoute[] => {
  if (!Array.isArray(routes)) {
    return [];
  }

  return routes.flatMap((route) => [route, ...flattenRoutes(route.children)]);
};

const findRouteByAlias = (routes: NocoBaseDesktopRoute[], alias: string) =>
  flattenRoutes(routes).find((route) => route.type === 'flowPage' && route.schemaUid && getPathAlias(route) === alias);

const findRouteBySchemaUid = (routes: NocoBaseDesktopRoute[], schemaUid: string) =>
  flattenRoutes(routes).find(
    (route) => route.type === 'flowPage' && route.schemaUid === schemaUid && getPathAlias(route),
  );

const findFlowRouteBySchemaUid = (routes: NocoBaseDesktopRoute[], schemaUid: string) =>
  flattenRoutes(routes).find((route) => route.type === 'flowPage' && route.schemaUid === schemaUid);

const hasNativeRouteIdentity = (routes: NocoBaseDesktopRoute[], identity: string) =>
  flattenRoutes(routes).some((route) => route.schemaUid === identity || String(route.id) === identity);

const findAccessibleRouteByAlias = (
  routes: NocoBaseDesktopRoute[],
  alias: string,
  previousAliases?: Map<string, string>,
) => {
  const currentRoute = findRouteByAlias(routes, alias);
  if (currentRoute) {
    return currentRoute;
  }

  if (hasNativeRouteIdentity(routes, alias)) {
    return undefined;
  }

  const previousSchemaUid = previousAliases?.get(alias);
  return previousSchemaUid ? findFlowRouteBySchemaUid(routes, previousSchemaUid) : undefined;
};

const snapshotAliasRoutes = (routes: NocoBaseDesktopRoute[]) =>
  flattenRoutes(routes)
    .filter((route) => route.type === 'flowPage' && route.schemaUid && getPathAlias(route))
    .map(
      (route) =>
        ({
          id: route.id,
          type: route.type,
          schemaUid: route.schemaUid,
          options: { pathAlias: getPathAlias(route) },
        }) as NocoBaseDesktopRoute,
    );

const getAliasRouteSignature = (routes: NocoBaseDesktopRoute[]) =>
  JSON.stringify(
    flattenRoutes(routes)
      .filter((route) => route.type === 'flowPage')
      .map((route) => [String(route.id), route.schemaUid, getPathAlias(route)]),
  );

const getPreviousAliasHistory = (engine: object, layoutUid: string) =>
  previousAliasHistoryByEngine.get(engine)?.get(layoutUid) || new Map<string, string>();

const updatePreviousAliasHistory = (
  engine: object,
  layoutUid: string,
  previousRoutes: NocoBaseDesktopRoute[],
  accessibleRoutes: NocoBaseDesktopRoute[],
) => {
  const histories = previousAliasHistoryByEngine.get(engine) || new Map<string, Map<string, string>>();
  const aliases = new Map(histories.get(layoutUid) || []);

  for (const route of flattenRoutes(previousRoutes)) {
    const alias = getPathAlias(route);
    if (route.type === 'flowPage' && route.schemaUid && alias) {
      aliases.set(alias, route.schemaUid);
    }
  }

  for (const [alias, schemaUid] of aliases) {
    // A current alias assignment always wins, including when a slug was reassigned.
    if (
      findRouteByAlias(accessibleRoutes, alias) ||
      hasNativeRouteIdentity(accessibleRoutes, alias) ||
      !findFlowRouteBySchemaUid(accessibleRoutes, schemaUid)
    ) {
      aliases.delete(alias);
    }
  }

  while (aliases.size > maxPreviousAliasHistorySize) {
    const oldestAlias = aliases.keys().next().value;
    if (oldestAlias === undefined) {
      break;
    }
    aliases.delete(oldestAlias);
  }

  histories.set(layoutUid, aliases);
  previousAliasHistoryByEngine.set(engine, histories);
  return aliases;
};

const findSiblingRoutes = (routes: NocoBaseDesktopRoute[], routeId: string | number) => {
  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index];
    if (String(route.id) === String(routeId)) {
      return { previous: routes[index - 1], next: routes[index + 1] };
    }
    if (route.children?.length) {
      const siblings = findSiblingRoutes(route.children, routeId);
      if (siblings.previous || siblings.next) {
        return siblings;
      }
    }
  }

  return { previous: undefined, next: undefined };
};

const resolveRouterPathname = (pathname: string, basename?: string) => toRouterNavigationPath(pathname, basename);

const getPathSegments = (path: string) => {
  const separatorIndex = path.search(/[?#]/);
  return separatorIndex < 0
    ? { pathname: path, suffix: '' }
    : { pathname: path.slice(0, separatorIndex), suffix: path.slice(separatorIndex) };
};

const normalizePath = (path: string) => {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '/') {
    return '/';
  }
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
};

const replaceLayoutRouteSegment = (path: string, layoutBasePath: string, from: string, to: string) => {
  const { pathname, suffix } = getPathSegments(path);
  const basePath = normalizePath(layoutBasePath);
  if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
    return path;
  }

  const remainder = pathname.slice(basePath.length);
  if (!remainder.startsWith('/')) {
    return path;
  }

  const firstSegment = remainder.slice(1).split('/')[0];
  if (firstSegment !== from) {
    return path;
  }

  const suffixPath = remainder.slice(firstSegment.length + 1);
  return `${basePath}/${to}${suffixPath}${suffix}`;
};

export function resolveAliasPathnameToSchemaUid(
  pathname: string,
  layoutBasePath: string,
  accessibleRoutes: NocoBaseDesktopRoute[],
  previousAliases?: Map<string, string>,
) {
  const { pathname: pathOnly } = getPathSegments(pathname);
  const basePath = normalizePath(layoutBasePath);
  if (pathOnly !== basePath && !pathOnly.startsWith(`${basePath}/`)) {
    return pathname;
  }

  const remainder = pathOnly.slice(basePath.length);
  if (!remainder.startsWith('/')) {
    return pathname;
  }

  const alias = remainder.slice(1).split('/')[0];
  const route = findAccessibleRouteByAlias(accessibleRoutes, alias, previousAliases);
  return route?.schemaUid ? replaceLayoutRouteSegment(pathname, basePath, alias, route.schemaUid) : pathname;
}

export function resolveSchemaUidPathnameToAlias(
  pathname: string,
  layoutBasePath: string,
  accessibleRoutes: NocoBaseDesktopRoute[],
) {
  const { pathname: pathOnly } = getPathSegments(pathname);
  const basePath = normalizePath(layoutBasePath);
  if (pathOnly !== basePath && !pathOnly.startsWith(`${basePath}/`)) {
    return pathname;
  }

  const remainder = pathOnly.slice(basePath.length);
  if (!remainder.startsWith('/')) {
    return pathname;
  }

  const schemaUid = remainder.slice(1).split('/')[0];
  const route = findRouteBySchemaUid(accessibleRoutes, schemaUid);
  const alias = getPathAlias(route);
  return alias ? replaceLayoutRouteSegment(pathname, basePath, schemaUid, alias) : pathname;
}

const resolvePreviousAliasPathname = (
  pathname: string,
  layoutBasePath: string,
  accessibleRoutes: NocoBaseDesktopRoute[],
  previousAliases: Map<string, string>,
) => {
  const { pathname: pathOnly } = getPathSegments(pathname);
  const basePath = normalizePath(layoutBasePath);
  if (pathOnly !== basePath && !pathOnly.startsWith(`${basePath}/`)) {
    return pathname;
  }

  const remainder = pathOnly.slice(basePath.length);
  if (!remainder.startsWith('/')) {
    return pathname;
  }

  const previousAlias = remainder.slice(1).split('/')[0];
  if (findRouteByAlias(accessibleRoutes, previousAlias) || hasNativeRouteIdentity(accessibleRoutes, previousAlias)) {
    return pathname;
  }

  const previousSchemaUid = previousAliases.get(previousAlias);
  if (!previousSchemaUid) {
    return pathname;
  }

  const currentRoute = findFlowRouteBySchemaUid(accessibleRoutes, previousSchemaUid);
  if (!currentRoute?.schemaUid) {
    return pathname;
  }

  return replaceLayoutRouteSegment(
    pathname,
    basePath,
    previousAlias,
    getPathAlias(currentRoute) || currentRoute.schemaUid,
  );
};

export const AliasAwareAdminLayoutEntry = ({
  model,
  children,
}: {
  model: AliasAwareAdminLayoutModel;
  children?: React.ReactNode;
}) => {
  const location = useLocation();
  const matches = useMatches();
  const routeContext = useContext(UNSAFE_RouteContext);
  const navigate = useNavigate();
  const repository = model.flowEngine.context.routeRepository as AliasRouteRepository | undefined;
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'failed'>(() =>
    repository ? 'loading' : 'loaded',
  );
  const [, setRouteRevision] = useState(0);
  const previousAliasesRef = useRef<Map<string, string>>(new Map());
  const currentRoutesRef = useRef<NocoBaseDesktopRoute[]>([]);
  const currentRoutesSignatureRef = useRef<string | undefined>();
  const currentRoutesLayoutUidRef = useRef<string | undefined>();
  const layout = model.layout;
  const [loadedLayoutUid, setLoadedLayoutUid] = useState<string | undefined>();
  const loaded = !repository || (loadedLayoutUid === layout.uid && loadState !== 'loading');
  const hasLoadedLayoutRoutes = loadState === 'loaded' && loadedLayoutUid === layout.uid;
  const routes = hasLoadedLayoutRoutes ? repository?.listAccessible?.() || [] : [];
  if (hasLoadedLayoutRoutes) {
    if (currentRoutesLayoutUidRef.current !== layout.uid) {
      currentRoutesLayoutUidRef.current = layout.uid;
      previousAliasesRef.current = getPreviousAliasHistory(model.flowEngine, layout.uid);
      currentRoutesRef.current = [];
      currentRoutesSignatureRef.current = undefined;
    }
    const routesSignature = getAliasRouteSignature(routes);
    if (routesSignature !== currentRoutesSignatureRef.current) {
      previousAliasesRef.current = updatePreviousAliasHistory(
        model.flowEngine,
        layout.uid,
        currentRoutesRef.current,
        routes,
      );
      currentRoutesRef.current = snapshotAliasRoutes(routes);
      currentRoutesSignatureRef.current = routesSignature;
    }
  }
  const layoutBasePathname =
    matches.find((match) => match.id === layout.routeName)?.pathname ||
    (layout.routePath.startsWith('/') ? layout.routePath : '/admin');
  const schemaUidAliasPathname = resolveSchemaUidPathnameToAlias(location.pathname, layoutBasePathname, routes);
  const previousAliasPathname = resolvePreviousAliasPathname(
    location.pathname,
    layoutBasePathname,
    routes,
    previousAliasesRef.current,
  );
  const aliasPathname = schemaUidAliasPathname !== location.pathname ? schemaUidAliasPathname : previousAliasPathname;
  const needsAliasRedirect = aliasPathname !== location.pathname;
  const pageMatch = [...matches].reverse().find((match) => match.id.startsWith(`${layout.routeName}.__page`));
  const pageAlias = pageMatch?.params.name;
  const aliasedRoute =
    typeof pageAlias === 'string'
      ? findAccessibleRouteByAlias(routes, pageAlias, previousAliasesRef.current)
      : undefined;
  const routeContextWithCanonicalPageUid = aliasedRoute?.schemaUid
    ? {
        ...routeContext,
        matches: routeContext.matches.map((match, index) =>
          index === routeContext.matches.length - 1
            ? { ...match, params: { ...match.params, name: aliasedRoute.schemaUid } }
            : match,
        ),
      }
    : routeContext;

  useLayoutEffect(() => {
    if (!repository) {
      setLoadState('loaded');
      return;
    }

    const deactivateLayout = repository.activateLayout?.({ uid: model.layout.uid });
    const unsubscribe = repository.subscribe?.(() => setRouteRevision((revision) => revision + 1));
    let active = true;
    const ensureAccessibleRoutes = async () => {
      if (!repository.isAccessibleLoaded?.()) {
        await repository.ensureAccessibleLoaded?.();
      }
      if (active) {
        setLoadedLayoutUid(model.layout.uid);
        setLoadState('loaded');
      }
    };

    ensureAccessibleRoutes().catch(() => {
      if (active) {
        setLoadedLayoutUid(model.layout.uid);
        setLoadState('failed');
      }
    });

    return () => {
      active = false;
      unsubscribe?.();
      deactivateLayout?.();
    };
  }, [model.layout.uid, repository]);

  useEffect(() => {
    if (!loaded || !needsAliasRedirect) {
      return;
    }

    navigate(
      {
        pathname: aliasPathname,
        search: location.search,
        hash: location.hash,
      },
      { replace: true, state: location.state },
    );
  }, [
    aliasPathname,
    loaded,
    location.hash,
    location.search,
    location.state,
    location.pathname,
    navigate,
    needsAliasRedirect,
  ]);

  if (!loaded) {
    return null;
  }

  return React.createElement(UNSAFE_RouteContext.Provider, { value: routeContextWithCanonicalPageUid }, children);
};

const getAccessibleRoutes = (app: App) => {
  const routeRepository = app.flowEngine.context.routeRepository as AliasRouteRepository | undefined;
  return routeRepository?.listAccessible?.() || [];
};

const resolveAliasLayoutMatch = (
  match: ReturnType<AdminLayoutModel['resolveLayoutRoute']>,
  accessibleRoutes: NocoBaseDesktopRoute[],
  previousAliases: Map<string, string>,
) => {
  if (match.type !== 'page') {
    return match;
  }

  const route = findAccessibleRouteByAlias(accessibleRoutes, match.pageUid, previousAliases);
  if (!route?.schemaUid) {
    return match;
  }

  const schemaUid = route.schemaUid;
  const viewStack = match.viewStack.map(
    (view, index): ViewParam => (index === 0 ? { ...view, viewUid: schemaUid } : view),
  );

  return {
    ...match,
    pageUid: schemaUid,
    viewStack,
  };
};

class AliasAwareAdminLayoutRouteCoordinator extends AdminLayoutRouteCoordinator {
  override syncRoute(routeLike: RouteLikeForCoordinator) {
    const basePath = routeLike.layoutBasePathname || this.layout?.routePath || '/admin';
    const layoutUid = this.layout?.uid;
    const pathname = routeLike.pathname
      ? resolveAliasPathnameToSchemaUid(
          routeLike.pathname,
          basePath,
          getAccessibleRoutesForEngine(this.flowEngine),
          layoutUid ? getPreviousAliasHistory(this.flowEngine, layoutUid) : undefined,
        )
      : routeLike.pathname;

    return super.syncRoute({ ...routeLike, pathname });
  }
}

const getAccessibleRoutesForEngine = (engine: AdminLayoutModel['flowEngine']) => {
  const repository = engine.context.routeRepository as AliasRouteRepository | undefined;
  return repository?.listAccessible?.() || [];
};

export class AliasAwareAdminLayoutModel extends AdminLayoutModel {
  override resolveLayoutRoute(routeLike: LayoutRouteLike) {
    return resolveAliasLayoutMatch(
      super.resolveLayoutRoute(routeLike),
      getAccessibleRoutesForEngine(this.flowEngine),
      getPreviousAliasHistory(this.flowEngine, this.layout.uid),
    );
  }

  protected override createRouteCoordinator() {
    return new AliasAwareAdminLayoutRouteCoordinator(this.flowEngine, this.getRouteCoordinatorOptions());
  }

  override render() {
    return React.createElement(AliasAwareAdminLayoutEntry, { model: this }, super.render());
  }
}

export class AliasAwareAdminLayoutMenuItemModel extends AdminLayoutMenuItemModel {
  override async destroy() {
    const route = this.getRoute();
    const alias = getPathAlias(route);
    if (route.type !== 'flowPage' || !route.id || !alias) {
      return super.destroy();
    }

    const layout = this.getLayout();
    const pathname = this.context.location?.pathname || (typeof window !== 'undefined' ? window.location.pathname : '');
    const normalizedPathname = resolveRouterPathname(pathname, this.context.router?.basename);
    const aliasPath = joinAdminLayoutRoutePath(layout, alias);
    const isCurrentAliasPath = normalizedPathname === aliasPath || normalizedPathname.startsWith(`${aliasPath}/`);
    if (!isCurrentAliasPath) {
      return super.destroy();
    }

    const routes = this.getRouteRepository().listAccessible();
    const sibling = findSiblingRoutes(routes, route.id).previous || findSiblingRoutes(routes, route.id).next;
    await this.getRouteRepository().deleteRoute(route.id);

    if (!sibling) {
      this.context.router.navigate('/');
      return true;
    }

    const target = resolveAdminRouteRuntimeTarget({
      app: this.context.app,
      route: sibling,
      layout,
    });
    if (!target.runtimePath) {
      return true;
    }
    if (target.navigationMode === 'document') {
      window.location.assign(target.runtimePath);
      return true;
    }

    this.context.router.navigate(toRouterNavigationPath(target.runtimePath, this.context.router?.basename));
    return true;
  }

  override toProLayoutRoute(options: Parameters<AdminLayoutMenuItemModel['toProLayoutRoute']>[0]) {
    const menuRoute = super.toProLayoutRoute(options);
    if (!menuRoute) {
      return menuRoute;
    }

    const route = this.getRoute();
    const landingRoute =
      route.type === 'flowPage' ? route : route.type === 'group' ? findFirstV2LandingRoute(route.children) : undefined;
    const alias = getPathAlias(landingRoute);
    if (!alias || !landingRoute?.schemaUid) {
      return menuRoute;
    }

    const layout = this.getLayout();
    const target = resolveAdminRouteRuntimeTarget({
      app: this.context.app,
      route: { ...landingRoute, schemaUid: alias },
      layout,
    });
    if (!target.runtimePath) {
      return menuRoute;
    }

    const aliasPath = joinAdminLayoutRoutePath(layout, alias);
    if (route.type === 'group') {
      return {
        ...menuRoute,
        redirect: aliasPath,
        _runtimePath: target.runtimePath,
      };
    }

    return {
      ...menuRoute,
      path: aliasPath,
      redirect: aliasPath,
      _runtimePath: target.runtimePath,
    };
  }
}

const getLayoutBasePaths = (app: App) => {
  const layouts = app.layoutManager?.listLayouts?.() || [];
  const routePaths = layouts
    .filter((layout) => layout.layoutModelClass === 'AdminLayoutModel')
    .map((layout) => layout.routePath)
    .filter((routePath): routePath is string => typeof routePath === 'string' && routePath.startsWith('/'))
    .map(normalizePath);
  const publicPath = typeof app.getPublicPath === 'function' ? normalizePath(app.getPublicPath()) : '/';
  const publicPathRoutes =
    publicPath === '/' ? [] : routePaths.map((routePath) => normalizePath(`${publicPath}${routePath}`));

  return Array.from(new Set([...routePaths, ...publicPathRoutes])).sort((a, b) => b.length - a.length);
};

const rewriteNavigationTarget = (app: App, to: RouterTo): RouterTo => {
  if (typeof to === 'number') {
    return to;
  }

  const pathname = typeof to === 'string' ? to : to.pathname;
  if (typeof pathname !== 'string') {
    return to;
  }

  const routes = getAccessibleRoutes(app);
  let rewrittenPath = pathname;
  for (const basePath of getLayoutBasePaths(app)) {
    const next = resolveSchemaUidPathnameToAlias(rewrittenPath, basePath, routes);
    if (next !== rewrittenPath) {
      rewrittenPath = next;
      break;
    }
  }

  if (rewrittenPath === pathname) {
    return to;
  }
  return typeof to === 'string' ? rewrittenPath : { ...to, pathname: rewrittenPath };
};

const installManagerNavigationAdapter = (app: App) => {
  const manager = app.router;
  const originalNavigate = manager.navigate.bind(manager);

  Object.defineProperty(manager, 'navigate', {
    configurable: true,
    value: ((to, options) => originalNavigate(rewriteNavigationTarget(app, to), options)) as typeof manager.navigate,
  });
};

const installRouterNavigationAdapter = (app: App) => {
  const manager = app.router;
  if (patchedRouterManagers.has(manager)) {
    return;
  }
  patchedRouterManagers.add(manager);
  installManagerNavigationAdapter(app);

  const originalGetRouterComponent = manager.getRouterComponent.bind(manager);
  manager.getRouterComponent = ((children?: React.ReactNode) => {
    const component = originalGetRouterComponent(children);
    const router = manager.router;
    if (router && !patchedRouters.has(router)) {
      patchedRouters.add(router);
      const originalNavigate = router.navigate.bind(router);
      router.navigate = ((to, options) =>
        originalNavigate(rewriteNavigationTarget(app, to), options)) as typeof router.navigate;
    }
    return component;
  }) as typeof manager.getRouterComponent;
};

export function installFriendlyPathAliases(app: App) {
  app.flowEngine.registerModels({
    AdminLayoutModel: AliasAwareAdminLayoutModel,
    AdminLayoutMenuItemModel: AliasAwareAdminLayoutMenuItemModel,
  });
  installRouterNavigationAdapter(app);
}
