/**
 * Local fallback for the removed mobile plugins (`@nocobase/plugin-mobile`).
 *
 * Provides no-op stand-ins so the notification plugin still compiles and the
 * desktop inbox keeps working. Mobile shell routing is intentionally disabled.
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

export const useMobileRoutes = (): MobileRoutesContextValue => ({
  refresh: async () => undefined,
  resource: undefined,
  schemaResource: undefined,
});

export const MobilePageProvider = ({ children }: { children?: React.ReactNode }) => <>{children}</>;

export const MobilePageHeader = ({ children }: { children?: React.ReactNode }) => <>{children}</>;

export const MobilePageContentContainer = ({ children }: { children?: React.ReactNode }) => <>{children}</>;

export const MobilePageNavigationBar = (props: any) => null;

export const MobileTabBarItem = (props: any) => null;

export const MobilePopup = ({ children }: { children?: React.ReactNode }) => <>{children}</>;