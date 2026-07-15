import React from 'react';
import { useAPIClient } from '@nocobase/client';
import { RouterConfigManagerView } from '../client-v2/RouterConfigManager';

export function RouterConfigManager() {
  const api = useAPIClient();

  return <RouterConfigManagerView api={api} />;
}

export default RouterConfigManager;
