/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { defaultTheme as presetTheme, useApp, useCurrentUserContext, useGlobalTheme } from '@nocobase/client-v2';
import { error } from '@nocobase/utils/client';
import React, { useEffect, useMemo } from 'react';
import {
  deserializeTheme,
  getEffectiveTheme,
  getUserThemeId,
  normalizeTheme,
  serializeTheme,
  THEME_STORAGE_KEY,
} from '../../client-v2/themeApi';
import type { ThemeId } from '../../types';
import { useThemeListContext } from './ThemeListProvider';

const ThemeIdContext = React.createContext<{
  currentThemeId?: ThemeId;
  defaultThemeId?: ThemeId;
}>({});

export const useThemeId = () => {
  return React.useContext(ThemeIdContext);
};

/**
 * 用于在页面加载时初始化主题
 */
const InitializeTheme: React.FC<React.PropsWithChildren> = ({ children }) => {
  const currentUser = useCurrentUserContext();
  const { setTheme } = useGlobalTheme();
  const { run, data, loading } = useThemeListContext();
  const defaultTheme = useMemo(() => data?.find((item) => item.default), [data]);
  const userThemeId = getUserThemeId(currentUser?.data?.data);
  const selectedTheme = useMemo(() => (data ? getEffectiveTheme(data, userThemeId) : undefined), [data, userThemeId]);
  const api = useApp().apiClient;

  useEffect(() => {
    const storageTheme = api.auth.getOption(THEME_STORAGE_KEY);
    if (storageTheme) {
      try {
        setTheme(normalizeTheme(deserializeTheme(JSON.parse(storageTheme)).config, presetTheme));
      } catch (err) {
        error(err);
      }
    }
  }, [api.auth, setTheme]);

  useEffect(() => {
    if (!data) {
      run();
      return;
    }

    if (selectedTheme) {
      setTheme(normalizeTheme(selectedTheme.config, presetTheme));
      api.auth.setOption(THEME_STORAGE_KEY, serializeTheme(selectedTheme));
    } else {
      setTheme(presetTheme);
      api.auth.setOption(THEME_STORAGE_KEY, null);
    }
  }, [api.auth, data, run, selectedTheme, setTheme]);

  const value = useMemo(
    () =>
      (loading && !data) || Boolean(currentUser?.loading)
        ? {}
        : {
            currentThemeId: selectedTheme?.id,
            defaultThemeId: defaultTheme?.id,
          },
    [currentUser?.loading, data, defaultTheme?.id, loading, selectedTheme?.id],
  );

  return <ThemeIdContext.Provider value={value}>{children}</ThemeIdContext.Provider>;
};

InitializeTheme.displayName = 'InitializeTheme';

export default InitializeTheme;
