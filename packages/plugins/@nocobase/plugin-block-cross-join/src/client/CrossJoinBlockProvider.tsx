/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { useFieldSchema } from '@formily/react';
import { useAPIClient } from '@nocobase/client';

interface CrossJoinContextValue {
  data: Record<string, any>[];
  loading: boolean;
  pagination: { page: number; pageSize: number; total: number };
  config: any;
  refresh: () => void;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
}

const CrossJoinContext = createContext<CrossJoinContextValue | null>(null);

export const useCrossJoinContext = () => {
  return useContext(CrossJoinContext);
};

export const CrossJoinBlockProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const fieldSchema = useFieldSchema();
  const api = useAPIClient();
  const decoratorProps = fieldSchema?.['x-decorator-props'] || {};
  const rawConfig = decoratorProps.config;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const config = useMemo(() => rawConfig, [JSON.stringify(rawConfig)]);

  const [data, setData] = useState<Record<string, any>[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(decoratorProps.params?.pageSize || 20);
  const [total, setTotal] = useState(0);

  const fetchData = useCallback(async () => {
    if (!config?.primarySource?.collection) return;

    setLoading(true);
    try {
      const res = await api.request({
        url: 'crossJoin:query',
        method: 'post',
        data: {
          config,
          page,
          pageSize,
        },
      });
      const body = res?.data;
      setData(body?.data || []);
      setTotal(body?.meta?.count || 0);
    } catch (err) {
      console.error('CrossJoin query failed:', err);
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [api, config, page, pageSize]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <CrossJoinContext.Provider
      value={{
        data,
        loading,
        pagination: { page, pageSize, total },
        config,
        refresh: fetchData,
        setPage,
        setPageSize,
      }}
    >
      {children}
    </CrossJoinContext.Provider>
  );
};
