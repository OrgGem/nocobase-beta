import { useApp } from '@nocobase/client-v2';
import { Select, type SelectProps } from 'antd';
import { useRequest } from 'ahooks';
import React from 'react';

export const SpaceSelect = (props: SelectProps<string | number>) => {
  const api = useApp().apiClient;
  const { data, loading } = useRequest(async () => {
    const response = await api.resource('aiBuildGuideSpaces').list({
      filter: { status: 'completed' },
      pageSize: 100,
      sort: ['-createdAt'],
    });
    const rows: unknown = response?.data?.data;
    return Array.isArray(rows)
      ? rows.filter(
          (row): row is { id: string | number; title: string } =>
            row &&
            typeof row === 'object' &&
            (typeof row.id === 'string' || typeof row.id === 'number') &&
            typeof row.title === 'string',
        )
      : [];
  });
  return (
    <Select
      {...props}
      loading={loading}
      options={data?.map((row) => ({ label: row.title, value: row.id }))}
      showSearch
      optionFilterProp="label"
    />
  );
};
