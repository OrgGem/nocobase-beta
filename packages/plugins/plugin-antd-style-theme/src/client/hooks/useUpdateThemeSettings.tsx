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
import { THEME_STORAGE_KEY } from '../../client-v2/themeApi';
import type { ThemeId } from '../../types';

export function useUpdateThemeSettings() {
  const api = useApp().apiClient;

  const updateUserThemeSettings = useCallback(
    async (themeId: ThemeId | null) => {
      try {
        await api.resource('users').updateAntdStyleTheme({
          values: {
            themeId,
          },
        });
        api.auth.setOption(THEME_STORAGE_KEY, null);
        window.location.reload();
      } catch (err) {
        error(err);
      }
    },
    [api],
  );

  return { updateUserThemeSettings };
}
