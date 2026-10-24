import { useApp } from '@nocobase/client-v2';
import { useRequest } from 'ahooks';
import { Select, type SelectProps } from 'antd';
import React from 'react';
import { useT } from '../locale';

export function CategorySelect(props: SelectProps<string | number>) {
  const api = useApp().apiClient;
  const t = useT();
  const { data, loading, error } = useRequest(async () => {
    const response = await api.request<{ data: Array<{ id: string | number; name: string; title?: string }> }>({
      url: 'ocrVerifyCategories:list',
      method: 'get',
      params: { filter: { enabled: true }, pageSize: 100, sort: ['-createdAt'], fields: ['id', 'name', 'title'] },
    });
    return response.data.data || [];
  });
  return (
    <Select
      {...props}
      loading={loading}
      options={data?.map((row) => ({ value: row.id, label: row.title || row.name }))}
      status={error ? 'error' : undefined}
      placeholder={props.placeholder || t('Select a verify category')}
      showSearch
      optionFilterProp="label"
    />
  );
}
