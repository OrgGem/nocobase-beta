/**
 * Local fallback types/hooks for the mobile plugins that were removed from this build.
 *
 * plugin-mobile and plugin-mobile-client are no longer part of the source build.
 * This file provides harmless no-op stand-ins so that desktop routing keeps working
 * and the client still compiles without a dependency on `@nocobase/plugin-mobile`.
 */

import React from 'react';
import { useMobileLayout } from '@nocobase/client';

export interface MobileRouteItem {
  id: number;
  schemaUid?: string;
  type: 'page' | 'link' | 'tabs';
  options?: any;
  title?: string;
  icon?: string;
  parentId?: number;
  children?: MobileRouteItem[];
  hideInMenu?: boolean;
  enableTabs?: boolean;
  hidden?: boolean;
}

export interface MobileRoutesContextValue {
  routeList?: MobileRouteItem[];
  refresh: () => Promise<any>;
  resource: any;
  schemaResource: any;
}

/**
 * Returns true only when the app is currently rendering inside the mobile shell.
 * With plugin-mobile removed from the build there is no mobile shell, so this
 * always reports desktop layout based on responsive breakpoints.
 */
export const useMobilePage = () => {
  const { isMobileLayout } = useMobileLayout();
  return isMobileLayout;
};

export const useMobileRoutes = (): MobileRoutesContextValue => {
  return {
    refresh: async () => undefined,
    resource: undefined,
    schemaResource: undefined,
  };
};

export const MobilePageProvider = ({ children }: { children?: React.ReactNode }) => <>{children}</>;

export const MobilePageHeader = ({ children }: { children?: React.ReactNode }) => <>{children}</>;

export const MobilePageContentContainer = ({ children }: { children?: React.ReactNode }) => <>{children}</>;

export const MobileTabBarItem = (props: any) => null;