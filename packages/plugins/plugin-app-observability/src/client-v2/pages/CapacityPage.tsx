import { Alert, Card, List, Progress, Typography } from 'antd';
import React from 'react';
import { observabilityApi } from '../api';
import { useVisiblePolling } from '../hooks';
import { useT } from '../locale';
import { CapacityTag, DataState } from './shared';

function translateMessage(
  t: (key: string, values?: Record<string, number | string>) => string,
  message: { key: string; values?: Record<string, number | string> } | undefined,
): string | undefined {
  return message ? t(message.key, message.values) : undefined;
}

export default function CapacityPage() {
  const t = useT();
  const load = React.useCallback(
    (api: Parameters<typeof observabilityApi.capacity>[0]) => observabilityApi.capacity(api),
    [],
  );
  const query = useVisiblePolling(load);
  const data = query.data;
  return (
    <main aria-labelledby="app-observability-capacity">
      <Typography.Title id="app-observability-capacity" level={2}>
        {t('Capacity')}
      </Typography.Title>
      <DataState {...query} empty={!data} retry={query.refresh}>
        <Card
          title={
            <>
              {t('Capacity state')} <CapacityTag state={data?.state} />
            </>
          }
        >
          {data?.assessedNodeId ? (
            <Typography.Paragraph type="secondary">
              {t('Assessed node')}: {data.assessedNodeId}
            </Typography.Paragraph>
          ) : null}
          <Progress percent={Math.round((data?.confidence ?? 0) * 100)} status="active" aria-label={t('Confidence')} />
          <Alert
            showIcon
            type={data?.state === 'critical' ? 'error' : data?.state === 'scale-soon' ? 'warning' : 'info'}
            message={translateMessage(t, data?.recommendation)}
            description={t('Recommendations are advisory only; this plugin never auto-scales resources.')}
          />
        </Card>
        <List
          header={<strong>{t('Evidence')}</strong>}
          dataSource={data?.signals ?? []}
          renderItem={(signal) => (
            <List.Item>
              <List.Item.Meta title={t(signal.key)} description={translateMessage(t, signal.evidence)} />
              <Progress percent={signal.utilization == null ? 0 : Math.min(100, Math.round(signal.utilization))} />
            </List.Item>
          )}
        />
      </DataState>
    </main>
  );
}
