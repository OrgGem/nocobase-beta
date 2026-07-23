import React from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { usePlugin } from '@nocobase/client';
import { PluginNextAppClient } from './index';
import { getHubInternalPagePath } from './hubRouteContract';

export const HubAdminRedirect = () => {
  const plugin = usePlugin(PluginNextAppClient);
  const location = useLocation();
  const params = useParams<{ '*': string }>();
  const appPath = plugin.hubRouteStore.getAppPath();
  const target = params['*'] || '';

  if (!appPath) {
    return null;
  }

  return <Navigate replace to={`${getHubInternalPagePath(appPath, target)}${location.search}${location.hash}`} />;
};

export default HubAdminRedirect;
