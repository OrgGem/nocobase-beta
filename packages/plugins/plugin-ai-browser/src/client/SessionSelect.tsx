import React from 'react';
import { Select } from 'antd';
import { useRequest } from '@nocobase/client';

function normalizeRecords(response: any) {
  const records = response?.data?.data || response?.data || response || [];
  return Array.isArray(records) ? records : [];
}

export const SessionSelect = (props: any) => {
  const { data, loading } = useRequest<any>({
    resource: 'aiBrowserSessions',
    action: 'list',
    params: {
      pageSize: 50,
      sort: ['-createdAt'],
    },
  });

  const options =
    normalizeRecords(data).map((item: any) => ({
      label: item.title ? `${item.title} (${item.status})` : `Session ${item.id} (${item.status})`,
      value: `${item.liveUrl}#id=${item.id}`,
    })) || [];

  return (
    <Select
      {...props}
      placeholder="Select an active browser session..."
      loading={loading}
      options={options}
      showSearch
      allowClear
      filterOption={(input, option) => (option?.label as string)?.toLowerCase().includes(input.toLowerCase())}
    />
  );
};
