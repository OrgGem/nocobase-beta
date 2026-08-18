import React from 'react';
import { Button, Card, Descriptions, Drawer, Input, Radio, Space, Table, Tag, Typography, message } from 'antd';
import { CheckOutlined, CloseOutlined, EyeOutlined } from '@ant-design/icons';
import { useApiClient as useAPIClient, useRequest } from '../hooks/useApiRequest';
import { useT } from '../skill-hub/locale';

const { Text, Paragraph } = Typography;

type ApprovalRow = {
  id: number;
  runId: number;
  toolCallId: string;
  toolName: string;
  actionType?: string | null;
  proposedInput?: Record<string, unknown> | null;
  editedInput?: Record<string, unknown> | null;
  reason?: string | null;
  decisionNote?: string | null;
  status: string;
  assignedToId?: number | null;
  requestedAt?: string | null;
  decidedAt?: string | null;
  expiresAt?: string | null;
  createdAt?: string | null;
};

const formatDate = (value?: string | null) => (value ? new Date(value).toLocaleString() : '-');

const isExpired = (row: ApprovalRow) =>
  row.status === 'pending' && Boolean(row.expiresAt) && new Date(String(row.expiresAt)).getTime() <= Date.now();

function errorMessage(error: unknown, fallback: string) {
  const response = error as { response?: { data?: { errors?: { message?: string }[] } } };
  return response?.response?.data?.errors?.[0]?.message || (error as Error)?.message || fallback;
}

function statusTag(t: (key: string) => string, status: string) {
  if (status === 'pending') return <Tag color="gold">{t('Pending')}</Tag>;
  if (status === 'approved') return <Tag color="green">{t('Approved')}</Tag>;
  if (status === 'rejected') return <Tag color="red">{t('Rejected')}</Tag>;
  if (status === 'expired') return <Tag>{t('Expired')}</Tag>;
  return <Tag>{status}</Tag>;
}

export const ApprovalsTab: React.FC = () => {
  const api = useAPIClient();
  const t = useT();
  const [scope, setScope] = React.useState<'pending' | 'all'>('pending');
  const [page, setPage] = React.useState(1);
  const [reviewing, setReviewing] = React.useState<ApprovalRow | null>(null);
  const [note, setNote] = React.useState('');
  const [editedInputText, setEditedInputText] = React.useState('');
  const [deciding, setDeciding] = React.useState<'approve' | 'reject' | null>(null);

  const requestParams = React.useMemo(
    () => ({
      sort: ['-createdAt'],
      page,
      pageSize: 20,
      filter: scope === 'pending' ? { status: 'pending' } : {},
    }),
    [scope, page],
  );

  const { data, loading, refresh } = useRequest<{ data?: ApprovalRow[]; meta?: { count?: number } }>(
    {
      url: 'agentLoopApprovals:list',
      params: requestParams,
    },
    { refreshDeps: [requestParams] },
  );

  const rows = React.useMemo(() => {
    const raw = data?.data;
    return Array.isArray(raw) ? raw : [];
  }, [data]);
  const total = data?.meta?.count || 0;

  const openReview = (row: ApprovalRow) => {
    setReviewing(row);
    setNote('');
    setEditedInputText(JSON.stringify(row.proposedInput || {}, null, 2));
  };

  const closeReview = () => {
    setReviewing(null);
    setDeciding(null);
  };

  const decide = async (decision: 'approve' | 'reject') => {
    if (!reviewing) return;
    let editedInput: unknown;
    if (decision === 'approve' && editedInputText.trim()) {
      try {
        editedInput = JSON.parse(editedInputText);
      } catch (error) {
        message.error(t('Edited input JSON is invalid: {{message}}', { message: (error as Error).message }));
        return;
      }
    }
    setDeciding(decision);
    try {
      await api.request({
        url: 'agentLoopApprovals:decide',
        method: 'post',
        params: { filterByTk: reviewing.id },
        data: {
          decision,
          note: note.trim(),
          ...(editedInput !== undefined ? { editedInput } : {}),
        },
      });
      message.success(t('Approval recorded'));
      closeReview();
      refresh();
    } catch (error) {
      message.error(t('Decision failed: {{message}}', { message: errorMessage(error, t('unknown error')) }));
      setDeciding(null);
    }
  };

  const columns = [
    {
      title: t('Run'),
      dataIndex: 'runId',
      key: 'runId',
      width: 80,
      render: (runId: number) => <Text>#{String(runId)}</Text>,
    },
    {
      title: t('Tool'),
      dataIndex: 'toolName',
      key: 'toolName',
      width: 180,
      render: (toolName: string) => <Text code>{toolName}</Text>,
    },
    {
      title: t('Type'),
      dataIndex: 'actionType',
      key: 'actionType',
      width: 120,
      render: (actionType?: string | null) =>
        actionType === 'escalation' ? <Tag color="orange">{t('Escalation')}</Tag> : <Tag>{t('Tool call')}</Tag>,
    },
    {
      title: t('Reason'),
      dataIndex: 'reason',
      key: 'reason',
      ellipsis: true,
    },
    {
      title: t('Requested'),
      dataIndex: 'requestedAt',
      key: 'requestedAt',
      width: 170,
      render: (value?: string | null) => formatDate(value),
    },
    {
      title: t('Expires'),
      dataIndex: 'expiresAt',
      key: 'expiresAt',
      width: 170,
      render: (value: string | null | undefined, record: ApprovalRow) =>
        isExpired(record) ? <Text type="danger">{formatDate(value)}</Text> : formatDate(value),
    },
    {
      title: t('Status'),
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (status: string) => statusTag(t, status),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 110,
      render: (_: unknown, record: ApprovalRow) =>
        record.status === 'pending' ? (
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => openReview(record)}>
            {t('Review')}
          </Button>
        ) : null,
    },
  ];

  const reviewExpired = reviewing ? isExpired(reviewing) : false;

  return (
    <div>
      <Card bordered={false}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
            <Text type="secondary">
              {t('Tool calls and escalations that need a human decision before the run continues.')}
            </Text>
            <Radio.Group
              value={scope}
              onChange={(event) => {
                setScope(event.target.value);
                setPage(1);
              }}
            >
              <Radio.Button value="pending">{t('Pending')}</Radio.Button>
              <Radio.Button value="all">{t('All')}</Radio.Button>
            </Radio.Group>
          </div>
          <Table
            rowKey="id"
            loading={loading}
            dataSource={rows}
            columns={columns}
            scroll={{ x: 'max-content' }}
            pagination={{
              current: page,
              pageSize: 20,
              total,
              onChange: (next) => setPage(next),
              showSizeChanger: false,
            }}
          />
        </Space>
      </Card>

      <Drawer
        title={t('Review approval')}
        width={620}
        open={Boolean(reviewing)}
        onClose={closeReview}
        footer={
          reviewing && reviewing.status === 'pending' ? (
            <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button
                danger
                icon={<CloseOutlined />}
                loading={deciding === 'reject'}
                disabled={reviewExpired}
                onClick={() => decide('reject')}
              >
                {t('Reject')}
              </Button>
              <Button
                type="primary"
                icon={<CheckOutlined />}
                loading={deciding === 'approve'}
                disabled={reviewExpired}
                onClick={() => decide('approve')}
              >
                {t('Approve')}
              </Button>
            </Space>
          ) : null
        }
      >
        {reviewing && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label={t('Run')}>#{String(reviewing.runId)}</Descriptions.Item>
              <Descriptions.Item label={t('Tool')}>
                <Text code>{reviewing.toolName}</Text>
              </Descriptions.Item>
              <Descriptions.Item label={t('Type')}>
                {reviewing.actionType === 'escalation' ? (
                  <Tag color="orange">{t('Escalation')}</Tag>
                ) : (
                  <Tag>{t('Tool call')}</Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label={t('Requested')}>{formatDate(reviewing.requestedAt)}</Descriptions.Item>
              <Descriptions.Item label={t('Expires')}>
                {reviewExpired ? (
                  <Text type="danger">{formatDate(reviewing.expiresAt)}</Text>
                ) : (
                  formatDate(reviewing.expiresAt)
                )}
              </Descriptions.Item>
              <Descriptions.Item label={t('Status')}>{statusTag(t, reviewing.status)}</Descriptions.Item>
            </Descriptions>

            {reviewing.reason && <Paragraph style={{ marginBottom: 0 }}>{reviewing.reason}</Paragraph>}
            {reviewExpired && (
              <Text type="danger">
                {t('The approval window has expired. Retry the run to request approval again.')}
              </Text>
            )}

            <div>
              <Text strong>{t('Proposed input')}</Text>
              <Input.TextArea
                aria-label={t('Proposed input')}
                rows={6}
                readOnly
                value={JSON.stringify(reviewing.proposedInput || {}, null, 2)}
                spellCheck={false}
                style={{ marginTop: 8 }}
              />
            </div>

            {reviewing.status === 'pending' && (
              <>
                <div>
                  <Text strong>{t('Edited input (optional)')}</Text>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                    {t('Approving sends this input to the tool instead of the proposed one.')}
                  </Text>
                  <Input.TextArea
                    aria-label={t('Edited input (optional)')}
                    rows={6}
                    spellCheck={false}
                    value={editedInputText}
                    onChange={(event) => setEditedInputText(event.target.value)}
                  />
                </div>
                <div>
                  <Text strong>{t('Decision note')}</Text>
                  <Input.TextArea
                    aria-label={t('Decision note')}
                    rows={2}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    style={{ marginTop: 8 }}
                  />
                </div>
              </>
            )}

            {reviewing.status !== 'pending' && reviewing.decisionNote && (
              <div>
                <Text strong>{t('Decision note')}</Text>
                <Paragraph style={{ marginBottom: 0, marginTop: 8 }}>{reviewing.decisionNote}</Paragraph>
              </div>
            )}
          </Space>
        )}
      </Drawer>
    </div>
  );
};
