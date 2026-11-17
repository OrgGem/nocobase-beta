/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useApp } from '@nocobase/client-v2';
import { useRequest } from 'ahooks';
import { error } from '@nocobase/utils/client';
import React, { createContext, useMemo } from 'react';
import { deserializeTheme, type StoredThemeItem, type ThemeItem } from '../../client-v2/themeApi';

interface TData {
  data?: ThemeItem[];
  error?: Error;
  run: () => void;
  refresh: () => void;
  loading: boolean;
}

const ThemeListContext = createContext<TData>({
  run: () => {},
  refresh: () => {},
  loading: false,
});
ThemeListContext.displayName = 'ThemeListContext';

export const useThemeListContext = () => {
  return React.useContext(ThemeListContext);
};

export const ThemeListProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const app = useApp();
  const api = app.apiClient;
  const {
    data,
    error: err,
    run,
    refresh,
    loading,
  } = useRequest(
    () =>
      api
        .request<{ data: StoredThemeItem[] }>({
          url: 'antdStyleThemeConfig:list',
          params: {
            sort: 'id',
            paginate: false,
          },
        })
        .then((res) => res?.data),
    {
      manual: true,
    },
  );

  const items = useMemo(() => {
    return data?.data?.map((item) => deserializeTheme(item));
  }, [data]);

  if (err) {
    error(err);
  }

  return (
    <ThemeListContext.Provider
      value={{
        data: items,
        error: err,
        run,
        refresh,
        loading,
      }}
    >
      {children}
    </ThemeListContext.Provider>
  );
};

ThemeListProvider.displayName = 'ThemeListProvider';
