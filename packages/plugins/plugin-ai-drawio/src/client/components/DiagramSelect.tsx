import React from 'react';
import { Select } from 'antd';
import { useRequest } from 'ahooks';
import { useApp } from '@nocobase/client-v2';
import { getWrappedListPayload } from '../apiResponse';

type DiagramOptionRecord = {
  id: string;
  title?: string;
};

export const DiagramSelect = (props: any) => {
  const api = useApp().apiClient;
  const { data, loading } = useRequest(() =>
    api.resource('aiDiagrams').list({
      pageSize: 200,
      sort: ['-updatedAt'],
    }),
  );

  const { rows } = getWrappedListPayload<DiagramOptionRecord>(data);
  const options =
    rows.map((item) => ({
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
