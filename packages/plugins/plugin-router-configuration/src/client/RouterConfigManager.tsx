// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { useAPIClient } from '@nocobase/client';
import { RouterConfigManagerView } from '../client-v2/RouterConfigManager';

export function RouterConfigManager({ embedded = false }: { embedded?: boolean } = {}) {
  const api = useAPIClient();

  return <RouterConfigManagerView api={api} embedded={embedded} />;
}

export default RouterConfigManager;
