import { Table, Typography } from 'antd';
import React from 'react';
import { observabilityApi } from '../api';
import { useVisiblePolling } from '../hooks';
import { useT } from '../locale';
import { DataState } from './shared';
export default function ServicesPage() {
  const t = useT();
  const load = React.useCallback(
    (api: Parameters<typeof observabilityApi.services>[0]) => observabilityApi.services(api),
    [],
  );
  const query = useVisiblePolling(load);
  const data = query.data ?? [];
  return (
    <main aria-labelledby="app-observability-services">
      <Typography.Title id="app-observability-services" level={2}>
        {t('Services')}
      </Typography.Title>
      <DataState {...query} empty={!data.length} retry={query.refresh}>
        <Table
          scroll={{ x: 900 }}
          rowKey={(record) => `${record.service}:${record.operation}`}
          dataSource={data}
          columns={[
            { title: t('Service'), dataIndex: 'service' },
            { title: t('Operation'), dataIndex: 'operation' },
            { title: t('Inflight'), dataIndex: 'inflight' },
            { title: t('Requests'), dataIndex: 'requestCount' },
            {
              title: t('Error rate'),
              dataIndex: 'errorRate',
              render: (value?: number) => `${((value ?? 0) * 100).toFixed(1)}%`,
            },
            {
              title: t('Latency p95'),
              dataIndex: 'p95LatencyMs',
              render: (value?: number) => (value == null ? '—' : `${value} ms`),
            },
            {
              title: t('TTFT'),
              dataIndex: 'ttftMs',
              render: (value?: number) => (value == null ? '—' : `${value} ms`),
            },
          ]}
        />
      </DataState>
    </main>
  );
}
