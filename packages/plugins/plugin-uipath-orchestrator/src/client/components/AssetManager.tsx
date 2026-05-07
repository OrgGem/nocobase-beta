/**
 * Asset Manager — list, create, update, delete assets
 */

import React from 'react';
import { Table, Tag } from 'antd';
import { useUiPathRequest } from '../hooks/useUiPathRequest';
import { useT } from '../locale';

export const AssetManager: React.FC = () => {
  const t = useT();
  const { data, loading } = useUiPathRequest('uipathAssets', 'list');

  const columns = [
    { title: t('Name'), dataIndex: 'Name', ellipsis: true },
    { title: t('Type'), dataIndex: 'ValueType', width: 120, render: (v: string) => <Tag>{v}</Tag> },
    { title: t('Scope'), dataIndex: 'ValueScope', width: 100 },
    {
      title: t('Value'), dataIndex: 'Value', ellipsis: true,
      render: (v: string, rec: any) => {
        if (rec.ValueType === 'Credential') return '••••••••';
        return v || rec.StringValue || rec.IntValue || String(rec.BoolValue ?? '-');
      },
    },
  ];

  return (
    <Table
      dataSource={data || []}
      columns={columns}
      rowKey="Id"
      loading={loading}
      size="small"
      pagination={{ pageSize: 50 }}
    />
  );
};
