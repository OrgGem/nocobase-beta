/**
 * Asset Manager - list, create, update, delete assets
 */

import React, { useState } from 'react';
import { Alert, Table, Tag, Space, Input, Select, Button } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { toUiPathArray, useUiPathRequest } from '../hooks/useUiPathRequest';
import { useT } from '../locale';
import { combineFilters, containsFilter, equalsFilter } from '../utils/odataFilters';

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
  const [search, setSearch] = useState('');
  const [valueType, setValueType] = useState<string | undefined>();
  const [scope, setScope] = useState<string | undefined>();
  const filter = combineFilters([
    containsFilter('Name', search),
    equalsFilter('ValueType', valueType),
    equalsFilter('ValueScope', scope),
  ]);
  const { data, loading, error, refresh } = useUiPathRequest('uipathAssets', 'list', {
    filter,
    top: 100,
    orderby: 'Name asc',
  });
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
      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search placeholder={t('Search asset name')} style={{ width: 240 }} onSearch={setSearch} allowClear />
        <Select
          placeholder={t('Type')}
          allowClear
          style={{ width: 150 }}
          value={valueType}
          onChange={setValueType}
          options={['Text', 'Bool', 'Integer', 'Credential'].map((value) => ({ label: value, value }))}
        />
        <Select
          placeholder={t('Scope')}
          allowClear
          style={{ width: 150 }}
          value={scope}
          onChange={setScope}
          options={['Global', 'PerRobot'].map((value) => ({ label: value, value }))}
        />
        <Button onClick={() => refresh()} icon={<ReloadOutlined />}>
          {t('Refresh')}
        </Button>
      </Space>
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
