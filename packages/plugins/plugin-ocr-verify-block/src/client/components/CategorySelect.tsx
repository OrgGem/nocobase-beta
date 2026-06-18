import React from 'react';
import { Select } from 'antd';
import { useRequest } from 'ahooks';
import { useApp } from '@nocobase/client-v2';
import { useT } from '../locale';

function normalizeRecords(response: any) {
  const records = response?.data?.data || response?.data || response || [];
  return Array.isArray(records) ? records : [];
}

export const CategorySelect = (props: any) => {
  const t = useT();
  const api = useApp().apiClient;
  const { data, loading } = useRequest<any>(() =>
    api.resource('ocrVerifyCategories').list({
      filter: { enabled: true },
      pageSize: 100,
      sort: ['-createdAt'],
    }),
  );

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
