import type { Application } from '@nocobase/client-v2';
import React from 'react';
import ThemeRuntime from './ThemeRuntime';

const installed = new WeakSet<Application['router']>();

export function installThemeRuntime(app: Application) {
  const router = app.router;
  if (installed.has(router)) return;
  const getRouterComponent = router.getRouterComponent.bind(router);
  router.getRouterComponent = (children) =>
    getRouterComponent(
      <>
        <ThemeRuntime />
        {children}
      </>,
    );
  installed.add(router);
}
