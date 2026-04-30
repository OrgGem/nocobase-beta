import React from 'react';
import { Select } from 'antd';
import { useRequest } from '@nocobase/client';

function normalizeRecords(response: any) {
  const records = response?.data?.data || response?.data || response || [];
  return Array.isArray(records) ? records : [];
}

export const SpaceSelect = (props: any) => {
  const { data, loading } = useRequest<any>({
    resource: 'aiBuildGuideSpaces',
    action: 'list',
    params: {
      filter: { status: 'completed' },
      pageSize: 100,
      sort: ['-createdAt'],
    },
  });

  const options = normalizeRecords(data).map((item: any) => ({
    label: item.title,
    value: item.id,
  })) || [];

  return (
    <Select
      {...props}
      loading={loading}
      options={options}
      showSearch
      filterOption={(input, option) =>
        (option?.label as string)?.toLowerCase().includes(input.toLowerCase())
      }
    />
  );
};
