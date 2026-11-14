// SPDX-License-Identifier: Apache-2.0

import React, { useCallback } from 'react';
import { useApp } from '@nocobase/client-v2';
import type { PermissionTabProps } from '@nocobase/plugin-acl/client-v2';
import { DirectoryPermissions, type PermissionRequestOptions } from '../../shared/DirectoryPermissions';

export default function ExternalStoragePermissions({ activeRole }: PermissionTabProps) {
  const api = useApp().apiClient;
  const request = useCallback((options: PermissionRequestOptions) => api.request(options), [api]);

  return activeRole?.name ? (
    <DirectoryPermissions key={activeRole.name} role={activeRole} request={request} apiClient={api} />
  ) : null;
}
