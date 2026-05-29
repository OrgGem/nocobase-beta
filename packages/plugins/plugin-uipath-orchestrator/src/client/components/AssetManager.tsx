/**
 * Asset Manager - list, create, update, delete assets
 */

import React from 'react';
import { Alert, Table, Tag } from 'antd';
import { toUiPathArray, useUiPathRequest } from '../hooks/useUiPathRequest';
import { useT } from '../locale';

function formatAssetValue(value: unknown, record: Record<string, unknown>): string {
  if (record.ValueType === 'Credential') {
    return '********';
  }

  const candidate = value || record.StringValue || record.IntValue || record.BoolValue;
  if (candidate === undefined || candidate === null || candidate === '') {
    return '-';
  }
  if (['string', 'number', 'boolean'].includes(typeof candidate)) {
    return String(candidate);
  }

  try {
    return JSON.stringify(candidate);
  } catch {
    return String(candidate);
  }
}

export const AssetManager: React.FC = () => {
  const t = useT();
  const { data, loading, error } = useUiPathRequest('uipathAssets', 'list');
  const assets = toUiPathArray(data);

  const columns = [
    { title: t('Name'), dataIndex: 'Name', ellipsis: true },
    { title: t('Type'), dataIndex: 'ValueType', width: 120, render: (v: string) => <Tag>{v}</Tag> },
    { title: t('Scope'), dataIndex: 'ValueScope', width: 100 },
    {
      title: t('Value'),
      dataIndex: 'Value',
      ellipsis: true,
      render: (v: unknown, rec: Record<string, unknown>) => formatAssetValue(v, rec),
    },
  ];

  return (
    <>
      {error ? (
        <Alert type="error" showIcon message={t('Failed')} description={error.message} style={{ marginBottom: 16 }} />
      ) : null}
      <Table
        dataSource={assets}
        columns={columns}
        rowKey="Id"
        loading={loading}
        size="small"
        pagination={{ pageSize: 50 }}
      />
    </>
  );
};
