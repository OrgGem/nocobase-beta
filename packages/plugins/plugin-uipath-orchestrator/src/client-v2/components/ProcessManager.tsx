/**
 * Process Manager — releases list + start job modal
 */

import React, { useState } from 'react';
import { Alert, Table, Tag, Space, Input, Switch, Button } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { toUiPathArray, useUiPathRequest } from '../hooks/useUiPathRequest';
import { useT } from '../locale';
import { useCurrentInstance } from '../context/InstanceContext';
import { combineFilters, textAnyFilter } from '../utils/odataFilters';

export const ProcessManager: React.FC = () => {
  const t = useT();
  const { processFilter } = useCurrentInstance();
  const [search, setSearch] = useState('');
  const [latestOnly, setLatestOnly] = useState(false);
  const filter = combineFilters([
    textAnyFilter(['Name', 'ProcessKey'], processFilter),
    textAnyFilter(['Name', 'ProcessKey'], search),
    latestOnly ? 'IsLatestVersion eq true' : undefined,
  ]);
  const { data, loading, error, refresh } = useUiPathRequest('uipathProcesses', 'list', {
    filter,
    top: 100,
    orderby: 'Name asc',
  });
  const processes = toUiPathArray(data);

  const columns = [
    { title: t('Name'), dataIndex: 'Name', ellipsis: true },
    { title: t('Process Key'), dataIndex: 'ProcessKey', ellipsis: true },
    { title: t('Version'), dataIndex: 'ProcessVersion', width: 100 },
    {
      title: t('Latest'),
      dataIndex: 'IsLatestVersion',
      width: 80,
      render: (v: boolean) => (v ? <Tag color="green">Yes</Tag> : <Tag>No</Tag>),
    },
    { title: t('Folder'), dataIndex: 'OrganizationUnitFullyQualifiedName', ellipsis: true },
  ];

  return (
    <>
      {error ? (
        <Alert type="error" showIcon message={t('Failed')} description={error.message} style={{ marginBottom: 16 }} />
      ) : null}
      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search placeholder={t('Search process name')} style={{ width: 260 }} onSearch={setSearch} allowClear />
        <Space>
          <Switch checked={latestOnly} onChange={setLatestOnly} />
          <span>{t('Latest only')}</span>
        </Space>
        <Button onClick={() => refresh()} icon={<ReloadOutlined />}>
          {t('Refresh')}
        </Button>
      </Space>
      <Table
        dataSource={processes}
        columns={columns}
        rowKey="Id"
        loading={loading}
        size="small"
        pagination={{ pageSize: 50 }}
      />
    </>
  );
};
