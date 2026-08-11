import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Collapse, Descriptions, Empty, Space, Spin, Table, Tag, Typography } from 'antd';
import { useApp } from '@nocobase/client-v2';

const namespace = '@nocobase/plugin-uipath-orchestrator';

type UiPathRecord = Record<string, unknown>;
type CorrelationConfidence = 'high' | 'medium' | 'low';

type Candidate = {
  record: UiPathRecord;
  confidence: CorrelationConfidence;
  reason: string;
};

type TraceTarget =
  | { kind: 'queueItem'; id: string | number; label?: string }
  | { kind: 'job'; id?: string | number; jobKey?: string; label?: string }
  | { kind: 'log'; log: UiPathRecord; label?: string };

type TraceData = {
  queueItem?: UiPathRecord;
  job?: UiPathRecord | null;
  log?: UiPathRecord;
  jobs?: Candidate[];
  queueItems?: Candidate[];
  logs?: UiPathRecord[];
  contextLogs?: UiPathRecord[];
  nearbyLogs?: UiPathRecord[];
  processingAttempts?: Array<{
    record: UiPathRecord;
    jobKey?: string;
    jobId?: number;
    window?: { start: string; end: string };
  }>;
  processingWindow?: { start: string; end: string; bufferSeconds?: number } | null;
  runtimeWindow?: { start: string; end: string } | null;
  limits?: Record<string, { returned: number; limit: number; truncated: boolean }>;
  diagnostics?: string[];
};

export interface CorrelationTracePanelProps {
  target: TraceTarget;
  instanceId?: string | number | null;
  folderId?: string | number | null;
  folderKey?: string | null;
  folderPath?: string | null;
  folderReady: boolean;
}

function unwrapActionResponse(response: unknown): TraceData {
  let current = response;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth += 1) {
    const record = current as UiPathRecord;
    if ('data' in record && record.data !== undefined) {
      current = record.data;
      continue;
    }
    if ('body' in record && record.body !== undefined) {
      current = record.body;
      continue;
    }
    break;
  }
  return (current && typeof current === 'object' ? current : {}) as TraceData;
}

function translate(app: ReturnType<typeof useApp>, key: string): string {
  return app.i18n.t(key, { ns: [namespace, 'client'] }) as string;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function getId(record: UiPathRecord): string | number | undefined {
  const id = record.Id;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

function formatTime(value: unknown): string {
  return typeof value === 'string' && value ? new Date(value).toLocaleString() : '-';
}

function confidenceTag(confidence: CorrelationConfidence, t: (key: string) => string) {
  const definition = {
    high: { color: 'green', label: t('Confirmed') },
    medium: { color: 'blue', label: t('Likely') },
    low: { color: 'gold', label: t('Possible') },
  }[confidence];
  return <Tag color={definition.color}>{definition.label}</Tag>;
}

function targetParams(target: TraceTarget): { action: string; params: UiPathRecord } {
  if (target.kind === 'queueItem') return { action: 'fromQueueItem', params: { queueItemId: target.id } };
  if (target.kind === 'job') return { action: 'fromJob', params: { jobId: target.id, jobKey: target.jobKey } };
  const log = target.log;
  return {
    action: 'fromLog',
    params: {
      logId: getId(log),
      timeStamp: typeof log.TimeStamp === 'string' ? log.TimeStamp : undefined,
      jobKey: typeof log.JobKey === 'string' ? log.JobKey : undefined,
      queueItemId: log.QueueItemId ?? log.queueItemId,
      queueItemKey:
        typeof (log.QueueItemKey ?? log.queueItemKey) === 'string' ? log.QueueItemKey ?? log.queueItemKey : undefined,
      queueReference: typeof (log.Reference ?? log.reference) === 'string' ? log.Reference ?? log.reference : undefined,
    },
  };
}

export const CorrelationTracePanel: React.FC<CorrelationTracePanelProps> = ({
  target,
  instanceId,
  folderId,
  folderKey,
  folderPath,
  folderReady,
}) => {
  const app = useApp();
  const api = app.apiClient;
  const t = (key: string) => translate(app, key);
  const [currentTarget, setCurrentTarget] = useState<TraceTarget>(target);
  const [history, setHistory] = useState<TraceTarget[]>([]);
  const [data, setData] = useState<TraceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    setCurrentTarget(target);
    setHistory([]);
  }, [target]);

  const request = useMemo(() => targetParams(currentTarget), [currentTarget]);

  useEffect(() => {
    if (!instanceId || !folderReady) {
      setData(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    api
      .request({
        url: `uipathCorrelations:${request.action}`,
        params: { instanceId, folderId, folderKey, folderPath, ...request.params },
      })
      .then((response) => {
        if (active) setData(unwrapActionResponse(response));
      })
      .catch((nextError: unknown) => {
        if (active) setError(nextError instanceof Error ? nextError : new Error(String(nextError)));
      })
      .finally(() => {
        if (active) setLoading(false);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, folderId, folderKey, folderPath, folderReady, instanceId, request]);

  const trace = (nextTarget: TraceTarget) => {
    setHistory((current) => [...current, currentTarget]);
    setCurrentTarget(nextTarget);
  };
  const goBack = () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory((current) => current.slice(0, -1));
    setCurrentTarget(previous);
  };

  if (loading) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }
  if (error) return <Alert type="error" showIcon message={t('Failed to load trace')} description={error.message} />;
  if (!data) return <Empty description={t('No trace data')} />;

  const logs = asArray<UiPathRecord>(data.logs);
  const contextLogs = asArray<UiPathRecord>(data.contextLogs?.length ? data.contextLogs : data.nearbyLogs);
  const limits = Object.values(data.limits || {}).filter((limit) => limit.truncated);
  const traceWindow = data.processingWindow || data.runtimeWindow;
  const candidateColumns = (kind: 'job' | 'queue') => [
    {
      title: t('Match'),
      width: 110,
      render: (_: unknown, candidate: Candidate) => confidenceTag(candidate.confidence, t),
    },
    {
      title: kind === 'job' ? t('Job') : t('Queue Item'),
      render: (_: unknown, candidate: Candidate) => {
        const record = candidate.record;
        return kind === 'job'
          ? record.ReleaseName || record.Key || record.Id
          : record.Reference || record.Key || record.Id;
      },
    },
    {
      title: t('Reason'),
      dataIndex: 'reason',
      render: (reason: string) => <Typography.Text type="secondary">{reason}</Typography.Text>,
    },
    {
      title: t('Actions'),
      width: 115,
      render: (_: unknown, candidate: Candidate) => {
        const record = candidate.record;
        const id = getId(record);
        if (kind === 'job') {
          return (
            <Button
              size="small"
              disabled={id === undefined && typeof record.Key !== 'string'}
              onClick={() =>
                trace({ kind: 'job', id, jobKey: typeof record.Key === 'string' ? record.Key : undefined })
              }
            >
              {t('Trace Job')}
            </Button>
          );
        }
        return (
          <Button
            size="small"
            disabled={id === undefined}
            onClick={() => id !== undefined && trace({ kind: 'queueItem', id })}
          >
            {t('Trace Queue')}
          </Button>
        );
      },
    },
  ];
  const logColumns = [
    { title: t('Time'), dataIndex: 'TimeStamp', width: 180, render: formatTime },
    { title: t('Level'), dataIndex: 'Level', width: 90, render: (level: string) => <Tag>{level}</Tag> },
    { title: t('Message'), dataIndex: 'Message', ellipsis: true },
    {
      title: t('Actions'),
      width: 105,
      render: (_: unknown, record: UiPathRecord) => (
        <Button size="small" disabled={getId(record) === undefined} onClick={() => trace({ kind: 'log', log: record })}>
          {t('Trace Log')}
        </Button>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {history.length ? (
        <Button size="small" onClick={goBack}>
          {t('Back')}
        </Button>
      ) : null}
      {traceWindow ? (
        <Descriptions bordered size="small" column={1} title={t('Execution Window')}>
          <Descriptions.Item label={t('Start')}>{formatTime(traceWindow.start)}</Descriptions.Item>
          <Descriptions.Item label={t('End')}>{formatTime(traceWindow.end)}</Descriptions.Item>
        </Descriptions>
      ) : null}
      {data.diagnostics?.map((diagnostic) => <Alert key={diagnostic} type="warning" showIcon message={diagnostic} />)}
      {limits.length ? (
        <Alert
          type="warning"
          showIcon
          message={t('Results limited')}
          description={limits.map((limit) => `${limit.returned}/${limit.limit}`).join(', ')}
        />
      ) : null}
      {data.processingAttempts?.length ? (
        <Descriptions bordered size="small" column={1} title={t('Processing Attempts')}>
          {data.processingAttempts.map((attempt, index) => (
            <Descriptions.Item
              key={`${attempt.jobId || attempt.jobKey || index}`}
              label={`${t('Attempt')} ${index + 1}`}
            >
              {attempt.jobKey || attempt.jobId || t('No job identity')} ·{' '}
              {attempt.window
                ? `${formatTime(attempt.window.start)} – ${formatTime(attempt.window.end)}`
                : t('No processing window')}
            </Descriptions.Item>
          ))}
        </Descriptions>
      ) : null}
      {data.jobs?.length ? (
        <Table
          size="small"
          rowKey={(candidate) => String(getId(candidate.record) || candidate.record.Key)}
          columns={candidateColumns('job')}
          dataSource={data.jobs}
          pagination={false}
        />
      ) : null}
      {data.queueItems?.length ? (
        <Table
          size="small"
          rowKey={(candidate) => String(getId(candidate.record) || candidate.record.Key)}
          columns={candidateColumns('queue')}
          dataSource={data.queueItems}
          pagination={false}
        />
      ) : null}
      <div>
        <Typography.Title level={5}>{t('Strict Execution Logs')}</Typography.Title>
        {logs.length ? (
          <Table
            size="small"
            rowKey={(record) => String(getId(record) || `${record.TimeStamp}-${record.Message}`)}
            columns={logColumns}
            dataSource={logs}
            pagination={{ pageSize: 20 }}
            scroll={{ y: 300 }}
          />
        ) : (
          <Empty description={t('No logs found for this transaction window')} />
        )}
      </div>
      {contextLogs.length ? (
        <Collapse
          items={[
            {
              key: 'context',
              label: t('Context Logs'),
              children: (
                <Table
                  size="small"
                  rowKey={(record) => String(getId(record) || `${record.TimeStamp}-${record.Message}`)}
                  columns={logColumns}
                  dataSource={contextLogs}
                  pagination={{ pageSize: 20 }}
                  scroll={{ y: 250 }}
                />
              ),
            },
          ]}
        />
      ) : null}
    </Space>
  );
};
