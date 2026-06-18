/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useApp } from '@nocobase/client-v2';
import { error } from '@nocobase/utils/client';
import { useCallback } from 'react';

export function useUpdateThemeSettings() {
  const api = useApp().apiClient;

  const updateUserThemeSettings = useCallback(
    async (themeId: number | null) => {
      try {
        await api.resource('users').updateAntdStyleTheme({
          values: {
            themeId,
          },
        });
        window.location.reload();
      } catch (err) {
        error(err);
      }
    },
    [api],
  );

  return { updateUserThemeSettings };
}
