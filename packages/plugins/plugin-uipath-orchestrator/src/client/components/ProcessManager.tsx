/**
 * Process Manager — releases list + start job modal
 */

import React from 'react';
import { Alert, Table, Button, Tag } from 'antd';
import { toUiPathArray, useUiPathRequest } from '../hooks/useUiPathRequest';
import { useT } from '../locale';

export const ProcessManager: React.FC = () => {
  const t = useT();
  const { data, loading, error } = useUiPathRequest('uipathProcesses', 'list');
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
    {
      title: t('Actions'),
      width: 100,
      render: () => (
        <Button size="small" type="primary" disabled>
          {t('Start Job')}
        </Button>
      ),
    },
  ];

  return (
    <>
      {error ? (
        <Alert type="error" showIcon message={t('Failed')} description={error.message} style={{ marginBottom: 16 }} />
      ) : null}
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
