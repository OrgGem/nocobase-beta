import { Table, Typography } from 'antd';
import React from 'react';
import { observabilityApi } from '../api';
import { useVisiblePolling } from '../hooks';
import { useT } from '../locale';
import { bytes, DataState, percent } from './shared';
export default function NodesPage() {
  const t = useT();
  const load = React.useCallback(
    (api: Parameters<typeof observabilityApi.nodes>[0]) => observabilityApi.nodes(api),
    [],
  );
  const query = useVisiblePolling(load);
  const data = query.data ?? [];
  return (
    <main aria-labelledby="app-observability-nodes">
      <Typography.Title id="app-observability-nodes" level={2}>
        {t('Nodes')}
      </Typography.Title>
      <DataState {...query} empty={!data.length} retry={query.refresh}>
        <Table
          scroll={{ x: 900 }}
          rowKey="nodeId"
          dataSource={data}
          columns={[
            { title: t('Node'), dataIndex: 'nodeId' },
            { title: t('Worker mode'), dataIndex: 'workerMode' },
            { title: t('CPU'), render: (_, record) => percent(record.runtime?.cpuPercent) },
            { title: t('RSS'), render: (_, record) => bytes(record.runtime?.rssBytes) },
            { title: t('Heap used'), render: (_, record) => bytes(record.runtime?.heapUsedBytes) },
            {
              title: t('ELU'),
              render: (_, record) =>
                percent(
                  record.runtime?.eventLoopUtilization == null ? null : record.runtime.eventLoopUtilization * 100,
                ),
            },
            {
              title: t('Event-loop p99'),
              render: (_, record) =>
                record.runtime?.eventLoopDelayP99Ms == null
                  ? '—'
                  : `${record.runtime.eventLoopDelayP99Ms.toFixed(1)} ms`,
            },
          ]}
        />
      </DataState>
    </main>
  );
}
