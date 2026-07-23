export const HUB_PATH = '/hub';
export const LEGACY_NEXT_APP_PATH = '/next-app';

export const HUB_ROUTE_NAMES = {
  root: 'hub',
  page: 'hub.page',
  tabs: 'hub.page.tabs',
  popups: 'hub.page.popups',
  tabPopups: 'hub.page.tabs.popups',
} as const;

const trimSlashes = (value: string) => value.replace(/^\/+|\/+$/g, '');

export function joinRoutePath(...parts: Array<string | undefined>) {
  const pathname = parts
    .filter((part): part is string => Boolean(part))
    .map(trimSlashes)
    .filter(Boolean)
    .join('/');
  return `/${pathname}`;
}

export function getHubBasename(routerBasename = '/') {
  return joinRoutePath(routerBasename, HUB_PATH);
}

export function getHubAppPath(appPath: string) {
  return joinRoutePath(HUB_PATH, appPath);
}

export function getHubPagePath(appPath: string, pageUid: string) {
  return joinRoutePath(HUB_PATH, appPath, pageUid);
}

export function getHubTabPath(appPath: string, pageUid: string, tabUid: string) {
  return joinRoutePath(getHubPagePath(appPath, pageUid), 'tabs', tabUid);
}

export function getHubPopupPath(appPath: string, pageUid: string, popupPath: string) {
  return joinRoutePath(getHubPagePath(appPath, pageUid), 'popups', popupPath);
}

export function getHubInternalPagePath(appPath: string, pageUid: string) {
  return joinRoutePath(appPath, pageUid);
}

export function redirectLegacyNextAppLocation(pathname: string, search = '', hash = '') {
  const suffix = pathname === LEGACY_NEXT_APP_PATH ? '' : pathname.slice(LEGACY_NEXT_APP_PATH.length);
  return `${HUB_PATH}${suffix}${search}${hash}`;
}

export function normalizeHubLink(link: string, appPath: string) {
  if (!link) {
    return joinRoutePath(appPath);
  }
  if (/^(https?:)?\/\//i.test(link) || /^(mailto|tel):/i.test(link)) {
    return link;
  }
  if (link === '/admin' || link === '/admin/') {
    return joinRoutePath(appPath);
  }
  if (link.startsWith('/admin/')) {
    return getHubInternalPagePath(appPath, link.slice('/admin/'.length));
  }
  if (link === HUB_PATH || link === `${HUB_PATH}/`) {
    return joinRoutePath(appPath);
  }
  if (link.startsWith(`${HUB_PATH}/`)) {
    return joinRoutePath(link.slice(HUB_PATH.length));
  }
  return getHubInternalPagePath(appPath, link);
}
