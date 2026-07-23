import { useSyncExternalStore } from 'react';
import type { NextAppDesktopRoute } from './nextAppRoutesContext';

type Listener = () => void;
const HUB_APP_PATH_SESSION_KEY = 'NOCOBASE_HUB_APP_PATH';

export class HubRouteStore {
  private routes: NextAppDesktopRoute[] = [];
  private appPath = '';
  private listeners = new Set<Listener>();
  private refreshHandler?: () => Promise<NextAppDesktopRoute[]>;

  getSnapshot = () => this.routes;

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setRoutes(routes: NextAppDesktopRoute[]) {
    this.routes = routes;
    this.listeners.forEach((listener) => listener());
  }

  setAppPath(appPath: string) {
    this.appPath = appPath;
    if (appPath && typeof window !== 'undefined') {
      window.sessionStorage.setItem(HUB_APP_PATH_SESSION_KEY, appPath);
    }
  }

  getAppPath() {
    if (this.appPath) {
      return this.appPath;
    }
    return typeof window === 'undefined' ? '' : window.sessionStorage.getItem(HUB_APP_PATH_SESSION_KEY) || '';
  }

  setRefreshHandler(handler?: () => Promise<NextAppDesktopRoute[]>) {
    this.refreshHandler = handler;
  }

  async refresh() {
    return this.refreshHandler ? this.refreshHandler() : this.routes;
  }
}

export function useHubRouteStore(store: HubRouteStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
