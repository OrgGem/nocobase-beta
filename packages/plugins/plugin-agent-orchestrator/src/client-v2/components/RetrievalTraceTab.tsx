import React, { useMemo, useState } from 'react';
import { Button, Card, Drawer, Empty, Space, Table, Tag, Typography } from 'antd';
import { EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import { useRequest } from '../hooks/useApiRequest';
import { useT } from '../skill-hub/locale';

type Citation = {
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  sourceId?: string;
  filename?: string;
  url?: string;
  collection?: string;
  recordId?: string;
  excerpt?: string;
  score?: number;
};

type RetrievalRow = {
  id: string | number;
  createdAt?: string;
  employeeUsername?: string;
  leaderUsername?: string;
  query?: string;
  decision: 'allowed' | 'denied';
  reason: string;
  citations: Citation[];
};

function responseRows(value: unknown): RetrievalRow[] {
  const body = value as { data?: unknown } | undefined;
  return Array.isArray(body?.data) ? (body.data as RetrievalRow[]) : [];
}

export const RetrievalTraceTab: React.FC = () => {
  const t = useT();
  const [selected, setSelected] = useState<RetrievalRow | null>(null);
  const request = useRequest({
    url: 'agentKnowledgeInsights:retrievalTrace',
    params: { page: 1, pageSize: 100 },
  });
  const rows = useMemo(() => responseRows(request.data), [request.data]);

  const columns = [
    {
      title: t('Time'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (value?: string) => (value ? new Date(value).toLocaleString() : '-'),
    },
    { title: t('AI Employee'), dataIndex: 'employeeUsername', key: 'employeeUsername', width: 160 },
    {
      title: t('Query'),
      dataIndex: 'query',
      key: 'query',
      render: (query?: string) => (
        <Typography.Paragraph ellipsis={{ rows: 2 }} style={{ margin: 0, maxWidth: 360 }}>
          {query || '-'}
        </Typography.Paragraph>
      ),
    },
    {
      title: t('Decision'),
      dataIndex: 'decision',
      key: 'decision',
      width: 110,
      render: (decision: RetrievalRow['decision']) => (
        <Tag color={decision === 'allowed' ? 'success' : 'error'}>
          {decision === 'allowed' ? t('Allowed') : t('Denied')}
        </Tag>
      ),
    },
    {
      title: t('Citations'),
      dataIndex: 'citations',
      key: 'citations',
      width: 100,
      render: (citations: Citation[]) => citations?.length || 0,
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 100,
      render: (_: unknown, row: RetrievalRow) => (
        <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => setSelected(row)}>
          {t('Detail')}
        </Button>
      ),
    },
  ];

  return (
    <Card bordered={false}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          {t(
            'Retrieval trace stores the decision, query, and safe source citations. It does not repeat raw RAG provider metadata.',
          )}
        </Typography.Text>
        <Button icon={<ReloadOutlined />} onClick={request.refresh} style={{ alignSelf: 'flex-start' }}>
          {t('Refresh')}
        </Button>
        <Table
          rowKey="id"
          loading={request.loading}
          dataSource={rows}
          columns={columns}
          scroll={{ x: 'max-content' }}
          pagination={{ pageSize: 50, showSizeChanger: true }}
        />
      </Space>
      <Drawer title={t('Retrieval detail')} open={Boolean(selected)} onClose={() => setSelected(null)} width={760}>
        {selected && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Typography.Text strong>{t('Decision')}</Typography.Text>
            <Tag color={selected.decision === 'allowed' ? 'success' : 'error'}>{selected.decision}</Tag>
            <Typography.Paragraph>
              <Typography.Text strong>{t('Reason')}: </Typography.Text>
              {selected.reason}
            </Typography.Paragraph>
            <Typography.Paragraph>
              <Typography.Text strong>{t('Query')}: </Typography.Text>
              {selected.query || '-'}
            </Typography.Paragraph>
            <Card title={t('Citations')} size="small">
              {selected.citations.length ? (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  {selected.citations.map((citation, index) => (
                    <Card key={`${citation.sourceId || citation.filename || index}`} size="small">
                      <Space direction="vertical" size={4} style={{ width: '100%' }}>
                        <Typography.Text strong>
                          {citation.filename || citation.sourceId || t('Unknown source')}
                        </Typography.Text>
                        <Typography.Text type="secondary">
                          {citation.knowledgeBaseName || citation.knowledgeBaseId || '-'}
                          {citation.score != null ? ` · ${citation.score.toFixed(3)}` : ''}
                        </Typography.Text>
                        {citation.url ? (
                          <Typography.Link href={citation.url} target="_blank" rel="noreferrer">
                            {citation.url}
                          </Typography.Link>
                        ) : null}
                        {citation.excerpt ? (
                          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                            {citation.excerpt}
                          </Typography.Paragraph>
                        ) : null}
                      </Space>
                    </Card>
                  ))}
                </Space>
              ) : (
                <Empty description={t('No citations were returned')} />
              )}
            </Card>
          </Space>
        )}
      </Drawer>
    </Card>
  );
};
