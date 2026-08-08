import { Card, Col, Row, Statistic, Table, Tag, Typography } from 'antd';
import React from 'react';
import { observabilityApi } from '../api';
import { useVisiblePolling } from '../hooks';
import { useT } from '../locale';
import { DataState } from './shared';

export default function OverviewPage() {
  const t = useT();
  const load = React.useCallback(
    (api: Parameters<typeof observabilityApi.overview>[0]) => observabilityApi.overview(api),
    [],
  );
  const query = useVisiblePolling(load);
  const data = query.data;
  const activeUserTitle =
    data?.activeUserScope === 'cluster-estimate'
      ? t('Active users (cluster estimate)')
      : data?.activeUserScope === 'node-local'
        ? t('Active users (this node)')
        : t('Active users');
  return (
    <main aria-labelledby="app-observability-overview">
      <Typography.Title id="app-observability-overview" level={2}>
        {t('Overview')}
      </Typography.Title>
      <DataState {...query} empty={!data} retry={query.refresh}>
        <Row gutter={[16, 16]}>
          <Col xs={24} md={12} xl={6}>
            <Card>
              <Statistic title={activeUserTitle} value={data?.activeUsers ?? 0} />
            </Card>
          </Col>
          <Col xs={24} md={12} xl={6}>
            <Card>
              <Statistic title={t('HTTP inflight')} value={data?.http?.inflight ?? 0} />
            </Card>
          </Col>
          <Col xs={24} md={12} xl={6}>
            <Card>
              <Statistic title={t('HTTP p95')} value={data?.http?.p95LatencyMs ?? 0} suffix="ms" />
            </Card>
          </Col>
          <Col xs={24} md={12} xl={6}>
            <Card>
              <Statistic title={t('Error rate')} value={(data?.http?.errorRate ?? 0) * 100} precision={1} suffix="%" />
            </Card>
          </Col>
        </Row>
        <Card title={t('LLM services')}>
          <Table
            scroll={{ x: 720 }}
            rowKey={(record) => `${record.service}:${record.operation}:${record.streaming ? 'stream' : 'standard'}`}
            pagination={false}
            dataSource={data?.llm ?? []}
            columns={[
              { title: t('Service'), dataIndex: 'service' },
              { title: t('Operation'), dataIndex: 'operation' },
              { title: t('Inflight'), dataIndex: 'inflight' },
              {
                title: t('TTFT'),
                dataIndex: 'ttftMs',
                render: (value?: number) => (value == null ? '—' : `${value} ms`),
              },
              { title: t('Tokens'), render: (_, record) => (record.inputTokens ?? 0) + (record.outputTokens ?? 0) },
            ]}
          />
        </Card>
        <Tag>{data?.aggregationMode === 'redis' ? t('Redis aggregation') : t('Single-node mode')}</Tag>
      </DataState>
    </main>
  );
}
