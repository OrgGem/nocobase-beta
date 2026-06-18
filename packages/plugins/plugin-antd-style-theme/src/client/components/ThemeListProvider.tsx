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
import { ThemeItem } from '../../types';
import { changeAlgorithmFromStringToFunction } from '../utils/changeAlgorithmFromStringToFunction';

interface TData {
  data?: ThemeItem[];
  error?: Error;
  run: () => void;
  refresh: () => void;
  loading: boolean;
}

const ThemeListContext = createContext<TData>(null);
ThemeListContext.displayName = 'ThemeListContext';

export const useThemeListContext = () => {
  return React.useContext(ThemeListContext);
};

export const ThemeListProvider = ({ children }) => {
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
        .request({
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
    return ((data as any)?.data as ThemeItem[])?.map((item) => changeAlgorithmFromStringToFunction(item));
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
