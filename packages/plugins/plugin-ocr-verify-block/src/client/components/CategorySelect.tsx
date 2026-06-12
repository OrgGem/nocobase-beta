import React from 'react';
import { Select } from 'antd';
import { useRequest } from '@nocobase/client';
import { useT } from '../locale';

function normalizeRecords(response: any) {
  const records = response?.data?.data || response?.data || response || [];
  return Array.isArray(records) ? records : [];
}

export const CategorySelect = (props: any) => {
  const t = useT();
  const { data, loading } = useRequest<any>({
    resource: 'ocrVerifyCategories',
    action: 'list',
    params: {
      filter: { enabled: true },
      pageSize: 100,
      sort: ['-createdAt'],
    },
  });

  const options =
    normalizeRecords(data).map((item: any) => ({
      label: item.title || item.name,
      value: item.id,
    })) || [];

  return (
    <Select
      {...props}
      loading={loading}
      options={options}
      placeholder={props.placeholder || t('Select a verify category')}
      showSearch
      filterOption={(input, option) => (option?.label as string)?.toLowerCase().includes(input.toLowerCase())}
    />
  );
};
