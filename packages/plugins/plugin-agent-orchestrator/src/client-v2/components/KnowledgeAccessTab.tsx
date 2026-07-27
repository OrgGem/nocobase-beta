import React, { useMemo, useState } from 'react';
import { Button, Card, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useRequest } from '../hooks/useApiRequest';
import { useT } from '../skill-hub/locale';

type AccessRow = {
  key: string;
  employeeUsername: string;
  employeeRoles: string[];
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  knowledgeBaseType: string;
  assigned: boolean;
  enabled: boolean;
  access: 'allowed' | 'denied';
  reason: string;
  userGate: string;
};

function rowsFromResponse(value: unknown): AccessRow[] {
  const body = value as { data?: unknown } | undefined;
  return Array.isArray(body?.data) ? (body.data as AccessRow[]) : [];
}

export const KnowledgeAccessTab: React.FC = () => {
  const t = useT();
  const [showDeniedOnly, setShowDeniedOnly] = useState(false);
  const request = useRequest({ url: 'agentKnowledgeInsights:accessMatrix' });
  const rows = useMemo(() => rowsFromResponse(request.data), [request.data]);
  const filteredRows = useMemo(
    () => (showDeniedOnly ? rows.filter((row) => row.access === 'denied') : rows),
    [rows, showDeniedOnly],
  );

  const columns = [
    { title: t('AI Employee'), dataIndex: 'employeeUsername', key: 'employeeUsername' },
    {
      title: t('Knowledge Base'),
      dataIndex: 'knowledgeBaseName',
      key: 'knowledgeBaseName',
      render: (name: string, row: AccessRow) => (
        <Space size={4} wrap>
          <span>{name}</span>
          <Tag>{row.knowledgeBaseType}</Tag>
        </Space>
      ),
    },
    {
      title: t('Assignment'),
      dataIndex: 'assigned',
      key: 'assigned',
      width: 120,
      render: (assigned: boolean) => (
        <Tag color={assigned ? 'blue' : 'default'}>{assigned ? t('Assigned') : t('Not assigned')}</Tag>
      ),
    },
    {
      title: t('Agent access'),
      dataIndex: 'access',
      key: 'access',
      width: 130,
      render: (access: AccessRow['access']) => (
        <Tag color={access === 'allowed' ? 'success' : 'error'}>
          {access === 'allowed' ? t('Allowed') : t('Denied')}
        </Tag>
      ),
    },
    {
      title: t('Reason'),
      dataIndex: 'reason',
      key: 'reason',
      render: (reason: string) => <Typography.Text>{reason}</Typography.Text>,
    },
    {
      title: t('Runtime user gate'),
      dataIndex: 'userGate',
      key: 'userGate',
      render: (gate: string) => (
        <Tooltip title={gate}>
          <Typography.Text ellipsis style={{ maxWidth: 260 }}>
            {gate}
          </Typography.Text>
        </Tooltip>
      ),
    },
  ];

  return (
    <Card bordered={false}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          {t(
            'This matrix checks employee assignment and static agent policy. BASIC and SHARED user access is still evaluated when a run starts.',
          )}
        </Typography.Text>
        <Space wrap>
          <Button type={showDeniedOnly ? 'primary' : 'default'} onClick={() => setShowDeniedOnly((value) => !value)}>
            {showDeniedOnly ? t('Show all') : t('Show denied only')}
          </Button>
          <Button icon={<ReloadOutlined />} onClick={request.refresh}>
            {t('Refresh')}
          </Button>
        </Space>
        <Table
          rowKey="key"
          loading={request.loading}
          dataSource={filteredRows}
          columns={columns}
          scroll={{ x: 'max-content' }}
          pagination={{ pageSize: 50, showSizeChanger: true }}
        />
      </Space>
    </Card>
  );
};
