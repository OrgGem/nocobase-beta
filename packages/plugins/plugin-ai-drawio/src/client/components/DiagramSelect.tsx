import React from 'react';
import { Select } from 'antd';
import { useRequest } from '@nocobase/client';

function normalizeRecords(response: any) {
  const records = response?.data?.data || response?.data || response || [];
  return Array.isArray(records) ? records : [];
}

export const DiagramSelect = (props: any) => {
  const { data, loading } = useRequest<any>({
    resource: 'aiDiagrams',
    action: 'list',
    params: {
      pageSize: 200,
      sort: ['-updatedAt'],
    },
  });

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
