import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  InputNumber,
  message,
  Progress,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DownloadOutlined,
  MedicineBoxOutlined,
  ReloadOutlined,
  StopOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useT } from './utils';

const { Text } = Typography;

interface DoctorRun {
  runId: string;
  status: string;
  durationMs: number;
  progress: number;
  startedAt: string;
  deadlineAt: string;
  finishedAt?: string;
  finishReason?: string;
  summary?: DoctorSummary;
  report?: DoctorReport;
  hasReport?: boolean;
  error?: string;
}

interface ActiveRun {
  runId: string;
  startedAt: string;
  deadlineAt: string;
  durationMs: number;
  startedBy?: string;
}

interface DoctorSummary {
  status: 'healthy' | 'warning' | 'critical';
  nodes: number;
  snapshotErrors: number;
  errors: number;
  warnings: number;
  versionDrift: boolean;
  runtimeDrift: boolean;
  pluginVersionDrifts: number;
  pluginLoadDrifts: number;
  packageDrifts: number;
  failedTasks?: number | null;
  failedWorkflows?: number | null;
}

interface DoctorReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  finishReason: string;
  summary: DoctorSummary;
  recommendations?: Array<{ level: string; code: string; message: string }>;
  logAnalysis?: {
    topSignatures?: Array<{
      signature: string;
      level: string;
      count: number;
      nodes?: string[];
      sources?: string[];
      samples?: string[];
    }>;
    byNode?: Array<{
      nodeId: string;
      hostname: string;
      role: string;
      levels?: Record<string, number>;
      files?: Array<{ file: string; lineCount: number }>;
      error?: string;
    }>;
  };
  pluginDiagnostics?: {
    plugins?: Array<{
      name: string;
      packageName: string;
      enabled: boolean;
      dbVersion?: string;
      runtimeVersions?: string[];
      versionDrift?: boolean;
      loadDrift?: boolean;
    }>;
  };
  packageDiagnostics?: {
    packageDrifts?: Array<{
      nodeId?: string;
      hostname?: string;
      role?: string;
      status?: string;
      missingPackages?: { apt?: string[]; npm?: string[]; python?: string[] };
    }>;
  };
}

function unwrapData(response: unknown) {
  const value = response as { data?: { data?: unknown } | unknown };
  if (value?.data && typeof value.data === 'object' && 'data' in value.data) {
    return (value.data as { data?: unknown }).data;
  }
  return value?.data;
}

function getApiErrorMessage(error: unknown, fallback: string) {
  const apiError = error as { response?: { data?: { errors?: Array<{ message?: string }> } }; message?: string };
  return apiError?.response?.data?.errors?.[0]?.message || apiError?.message || fallback;
}

function formatSeconds(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function statusColor(status?: string) {
  if (status === 'healthy' || status === 'finished') return 'green';
  if (status === 'critical' || status === 'failed') return 'red';
  if (status === 'running') return 'processing';
  return 'orange';
}

function countMissingPackages(packages?: { apt?: string[]; npm?: string[]; python?: string[] }) {
  return (packages?.apt?.length || 0) + (packages?.npm?.length || 0) + (packages?.python?.length || 0);
}

export function Doctor() {
  const t = useT();
  const api = useAPIClient();
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [durationMs, setDurationMs] = useState(120000);
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [run, setRun] = useState<DoctorRun | null>(null);
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [now, setNow] = useState(Date.now());

  const isRunning = Boolean(activeRun) || run?.status === 'running';
  const currentRunId = activeRun?.runId || run?.runId;
  const summary = report?.summary || run?.summary;
  const deadlineAt = activeRun?.deadlineAt || run?.deadlineAt;
  const remainingMs = deadlineAt ? Math.max(0, Date.parse(deadlineAt) - now) : 0;

  const loadStatus = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const response = await api.request({ url: 'clusterManagerDoctor:status' });
        const body = unwrapData(response) as { activeRun?: ActiveRun | null; run?: DoctorRun | null };
        setActiveRun(body?.activeRun || null);
        setRun(body?.run || null);
        if (body?.run?.report) {
          setReport(body.run.report);
        } else if (!body?.activeRun && body?.run?.hasReport && body?.run?.runId) {
          const reportResponse = await api.request({
            url: 'clusterManagerDoctor:report',
            params: { runId: body.run.runId },
          });
          const reportBody = unwrapData(reportResponse) as { report?: DoctorReport | null };
          setReport(reportBody?.report || null);
        }
      } catch {
        message.error(t('Failed to load diagnostic status'));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [api, t],
  );

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      loadStatus(true);
    }, 3000);
    return () => clearInterval(timer);
  }, [isRunning, loadStatus]);

  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isRunning]);

  const startDoctor = async () => {
    setStarting(true);
    setReport(null);
    try {
      const response = await api.request({
        url: 'clusterManagerDoctor:start',
        method: 'post',
        data: { durationMs },
      });
      const body = unwrapData(response) as ActiveRun;
      setActiveRun(body);
      message.success(t('Diagnostic session started'));
      await loadStatus(true);
    } catch (error) {
      message.error(getApiErrorMessage(error, t('Failed to start diagnostic session')));
    } finally {
      setStarting(false);
    }
  };

  const stopDoctor = async () => {
    if (!currentRunId) return;
    setStopping(true);
    try {
      const response = await api.request({
        url: 'clusterManagerDoctor:stop',
        method: 'post',
        data: { runId: currentRunId },
      });
      const body = unwrapData(response) as DoctorRun | null;
      setActiveRun(null);
      setRun(body || null);
      setReport(body?.report || null);
      message.success(t('Diagnostic report is ready'));
    } catch (error) {
      message.error(getApiErrorMessage(error, t('Failed to stop diagnostic session')));
    } finally {
      setStopping(false);
    }
  };

  const downloadReport = async () => {
    const runId = report?.runId || run?.runId;
    if (!runId) return;
    try {
      const response = await api.request({
        url: 'clusterManagerDoctor:download',
        params: { runId },
        responseType: 'blob',
      });
      const url = window.URL.createObjectURL(new Blob([response.data], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `doctor-report-${runId}.json`;
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      message.error(t('Failed to download diagnostic report'));
    }
  };

  const topSignatures = report?.logAnalysis?.topSignatures || [];
  const nodeRows = report?.logAnalysis?.byNode || [];
  const pluginDrifts = useMemo(
    () => (report?.pluginDiagnostics?.plugins || []).filter((plugin) => plugin.versionDrift || plugin.loadDrift),
    [report],
  );
  const packageDrifts = report?.packageDiagnostics?.packageDrifts || [];
  const recommendations = report?.recommendations || [];

  const signatureColumns: ColumnsType<(typeof topSignatures)[number]> = [
    {
      title: t('Level'),
      dataIndex: 'level',
      width: 90,
      render: (level: string) => <Tag color={level === 'error' ? 'red' : 'orange'}>{level}</Tag>,
    },
    { title: t('Count'), dataIndex: 'count', width: 90 },
    {
      title: t('Signature'),
      dataIndex: 'signature',
      render: (value: string) => <Text ellipsis={{ tooltip: value }}>{value}</Text>,
    },
    {
      title: t('Nodes'),
      dataIndex: 'nodes',
      width: 220,
      render: (nodes?: string[]) => (nodes || []).slice(0, 3).join(', '),
    },
  ];

  const nodeColumns: ColumnsType<(typeof nodeRows)[number]> = [
    { title: t('Node'), dataIndex: 'hostname' },
    { title: t('Role'), dataIndex: 'role', width: 110 },
    {
      title: t('Errors'),
      dataIndex: 'levels',
      width: 100,
      render: (levels?: Record<string, number>) => levels?.error || 0,
    },
    {
      title: t('Warnings'),
      dataIndex: 'levels',
      width: 110,
      render: (levels?: Record<string, number>) => levels?.warn || 0,
    },
    {
      title: t('Log Files'),
      dataIndex: 'files',
      render: (files?: Array<{ file: string; lineCount: number }>) =>
        files?.length ? files.map((file) => `${file.file} (${file.lineCount})`).join(', ') : '-',
    },
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Card
        size="small"
        title={
          <Space>
            <MedicineBoxOutlined />
            {t('Doctor')}
          </Space>
        }
        extra={
          <Button
            icon={<ReloadOutlined />}
            onClick={() => loadStatus(false)}
            loading={loading}
            aria-label={t('Refresh')}
          >
            {t('Refresh')}
          </Button>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space wrap>
            <InputNumber
              min={10}
              max={120}
              step={10}
              value={Math.round(durationMs / 1000)}
              onChange={(value) => setDurationMs((Number(value) || 120) * 1000)}
              addonAfter="s"
              disabled={isRunning}
              aria-label={t('Duration')}
              style={{ width: 140 }}
            />
            <Button
              type="primary"
              icon={<MedicineBoxOutlined />}
              onClick={startDoctor}
              loading={starting}
              disabled={isRunning}
            >
              {t('Start Doctor')}
            </Button>
            <Button danger icon={<StopOutlined />} onClick={stopDoctor} loading={stopping} disabled={!isRunning}>
              {t('Stop Doctor')}
            </Button>
            <Button
              icon={<DownloadOutlined />}
              onClick={downloadReport}
              disabled={!report?.runId && !run?.hasReport}
              aria-label={t('Download Report')}
            >
              {t('Download Report')}
            </Button>
          </Space>

          {isRunning && (
            <div>
              <Progress percent={run?.progress || 5} status="active" />
              <Text type="secondary">
                {t('Running')} - {formatSeconds(remainingMs)}
              </Text>
            </div>
          )}

          {run?.error && <Alert type="error" showIcon message={run.error} />}

          {run && (
            <Descriptions size="small" column={3}>
              <Descriptions.Item label={t('Run ID')}>{run.runId}</Descriptions.Item>
              <Descriptions.Item label={t('Status')}>
                <Tag color={statusColor(run.status)}>{t(run.status)}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('Started At')}>
                {run.startedAt ? new Date(run.startedAt).toLocaleString() : '-'}
              </Descriptions.Item>
              <Descriptions.Item label={t('Finished At')}>
                {run.finishedAt ? new Date(run.finishedAt).toLocaleString() : '-'}
              </Descriptions.Item>
              <Descriptions.Item label={t('Finish Reason')}>{run.finishReason || '-'}</Descriptions.Item>
              <Descriptions.Item label={t('Duration')}>
                {formatSeconds(report?.durationMs || run.durationMs)}
              </Descriptions.Item>
            </Descriptions>
          )}
        </Space>
      </Card>

      {summary && (
        <Row gutter={16}>
          <Col span={4}>
            <Card size="small">
              <Statistic
                title={t('Report Status')}
                value={t(summary.status)}
                valueStyle={{
                  color:
                    summary.status === 'critical' ? '#cf1322' : summary.status === 'warning' ? '#d48806' : '#3f8600',
                }}
              />
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Statistic title={t('Nodes')} value={summary.nodes} />
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Statistic
                title={t('Errors')}
                value={summary.errors}
                valueStyle={{ color: summary.errors ? '#cf1322' : undefined }}
              />
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Statistic title={t('Warnings')} value={summary.warnings} />
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Statistic title={t('Plugin Drift')} value={summary.pluginVersionDrifts + summary.pluginLoadDrifts} />
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Statistic title={t('Package Drift')} value={summary.packageDrifts} />
            </Card>
          </Col>
        </Row>
      )}

      {recommendations.length > 0 && (
        <Card
          title={
            <Space>
              <WarningOutlined />
              {t('Findings')}
            </Space>
          }
          size="small"
        >
          <Space direction="vertical" style={{ width: '100%' }}>
            {recommendations.map((item) => (
              <Alert
                key={item.code}
                type={item.level === 'critical' ? 'error' : 'warning'}
                showIcon
                message={item.message}
              />
            ))}
          </Space>
        </Card>
      )}

      {report && (
        <>
          <Card title={t('Node Log Distribution')} size="small">
            <Table
              rowKey="nodeId"
              size="small"
              pagination={{ pageSize: 5 }}
              dataSource={nodeRows}
              columns={nodeColumns}
            />
          </Card>

          <Card title={t('Top Error Signatures')} size="small">
            <Table
              rowKey={(record) => `${record.level}:${record.signature}`}
              size="small"
              pagination={{ pageSize: 5 }}
              dataSource={topSignatures}
              columns={signatureColumns}
            />
          </Card>

          <Card title={t('Plugin Drift')} size="small">
            <Table
              rowKey={(record) => record.packageName || record.name}
              size="small"
              pagination={{ pageSize: 6 }}
              dataSource={pluginDrifts}
              columns={[
                { title: t('Plugin'), dataIndex: 'name' },
                { title: t('Package'), dataIndex: 'packageName' },
                { title: t('DB Version'), dataIndex: 'dbVersion', width: 140 },
                {
                  title: t('Runtime Versions'),
                  dataIndex: 'runtimeVersions',
                  render: (versions: string[]) => versions?.join(', ') || '-',
                },
                {
                  title: t('Type'),
                  key: 'type',
                  width: 160,
                  render: (_, record) => (
                    <Space size={4}>
                      {record.versionDrift && <Tag color="orange">{t('Version')}</Tag>}
                      {record.loadDrift && <Tag color="purple">{t('Loaded')}</Tag>}
                    </Space>
                  ),
                },
              ]}
            />
          </Card>

          <Card title={t('Package Drift')} size="small">
            <Table
              rowKey={(record, index) => record.nodeId || record.hostname || String(index)}
              size="small"
              pagination={{ pageSize: 6 }}
              dataSource={packageDrifts}
              columns={[
                { title: t('Node'), dataIndex: 'hostname' },
                { title: t('Role'), dataIndex: 'role', width: 110 },
                { title: t('Package Status'), dataIndex: 'status', width: 140 },
                {
                  title: t('Missing Packages'),
                  dataIndex: 'missingPackages',
                  render: (packages: { apt?: string[]; npm?: string[]; python?: string[] }) =>
                    countMissingPackages(packages) || '-',
                },
              ]}
            />
          </Card>
        </>
      )}
    </Space>
  );
}
