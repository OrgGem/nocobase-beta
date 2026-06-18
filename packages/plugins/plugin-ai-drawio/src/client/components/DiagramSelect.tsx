import React from 'react';
import { Select } from 'antd';
import { useRequest } from 'ahooks';
import { useApp } from '@nocobase/client-v2';

function normalizeRecords(response: any) {
  const records = response?.data?.data || response?.data || response || [];
  return Array.isArray(records) ? records : [];
}

export const DiagramSelect = (props: any) => {
  const api = useApp().apiClient;
  const { data, loading } = useRequest<any>(() =>
    api.resource('aiDiagrams').list({
      pageSize: 200,
      sort: ['-updatedAt'],
    }),
  );

  const options =
    normalizeRecords(data).map((item: any) => ({
      label: item.title || item.id,
      value: item.id,
    })) || [];

  return (
    <Select
      {...props}
      loading={loading}
      options={options}
      showSearch
      allowClear
      filterOption={(input, option) => (option?.label as string)?.toLowerCase().includes(input.toLowerCase())}
    />
  );
};
