/**
 * Process Manager — releases list + start job modal
 */

import React from 'react';
import { Table, Button, Tag } from 'antd';
import { useUiPathRequest } from '../hooks/useUiPathRequest';
import { useT } from '../locale';

export const ProcessManager: React.FC = () => {
  const t = useT();
  const { data, loading, refresh } = useUiPathRequest('uipathProcesses', 'list');

  const columns = [
    { title: t('Name'), dataIndex: 'Name', ellipsis: true },
    { title: t('Process Key'), dataIndex: 'ProcessKey', ellipsis: true },
    { title: t('Version'), dataIndex: 'ProcessVersion', width: 100 },
    { title: t('Latest'), dataIndex: 'IsLatestVersion', width: 80, render: (v: boolean) => v ? <Tag color="green">Yes</Tag> : <Tag>No</Tag> },
    { title: t('Folder'), dataIndex: 'OrganizationUnitFullyQualifiedName', ellipsis: true },
    {
      title: t('Actions'), width: 100,
      render: (_: any, record: any) => (
        <Button size="small" type="primary" disabled>
          {t('Start Job')}
        </Button>
      ),
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
