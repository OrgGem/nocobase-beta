// SPDX-License-Identifier: Apache-2.0

import React, { useCallback } from 'react';
import { useAPIClient } from '@nocobase/client';
import { DirectoryPermissions, type PermissionRequestOptions } from '../../shared/DirectoryPermissions';

export const ExternalStoragePermissions = ({
  activeRole,
}: {
  activeRole?: { name: string; title?: string } | null;
}) => {
  const api = useAPIClient();
  const request = useCallback((options: PermissionRequestOptions) => api.request(options), [api]);

  return activeRole?.name ? (
    <DirectoryPermissions key={activeRole.name} role={activeRole} request={request} apiClient={api} />
  ) : null;
};
