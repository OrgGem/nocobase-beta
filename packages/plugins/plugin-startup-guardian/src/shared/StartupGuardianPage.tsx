/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Popconfirm, Space, Spin, Switch, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ApprovedPolicyRule, GuardianPolicy, GuardianState, StartupIncident } from '../server/contracts';

interface ApiRequest {
  url: string;
  method?: 'get' | 'post';
  data?: Record<string, unknown>;
}

interface StartupGuardianPageProps {
  request(options: ApiRequest): Promise<unknown>;
  t(key: string): string;
}

interface StatusResponse {
  state: GuardianState | null;
  policy: GuardianPolicy;
  autoRecoverySupported: boolean;
  policyMutationSupported: boolean;
  retrySupported: boolean;
  mode: string;
}

interface InspectResponse {
  incidents: StartupIncident[];
}

export function StartupGuardianPage({ request, t }: StartupGuardianPageProps) {
  const [status, setStatus] = useState<StatusResponse>();
  const [incidents, setIncidents] = useState<StartupIncident[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [statusResponse, inspectResponse] = await Promise.all([
        request({ url: 'startupGuardian:status' }),
        request({ url: 'startupGuardian:inspect' }),
      ]);
      const nextStatus = readPayload<StatusResponse>(statusResponse);
      const nextInspect = readPayload<InspectResponse>(inspectResponse);
      setStatus(nextStatus);
      setIncidents(Array.isArray(nextInspect.incidents) ? nextInspect.incidents : []);
    } catch (loadError) {
      setError(getErrorText(loadError));
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    refresh().catch((loadError: unknown) => setError(getErrorText(loadError)));
  }, [refresh]);

  const approve = async (incident: StartupIncident) => {
    setSaving(true);
    try {
      await request({
        url: 'startupGuardian:approve',
        method: 'post',
        data: {
          packageName: incident.packageName,
          pluginName: incident.pluginName,
          pluginVersion: incident.pluginVersion,
          phase: incident.phase,
          fingerprint: incident.fingerprint,
          expectedPolicyRevision: status?.policy.revision,
        },
      });
      message.success(t('Exact incident approved'));
      await refresh();
    } catch (approvalError) {
      message.error(getErrorText(approvalError));
    } finally {
      setSaving(false);
    }
  };

  const setAutomaticRecovery = async (enabled: boolean) => {
    setSaving(true);
    try {
      await request({
        url: 'startupGuardian:setAutoRecovery',
        method: 'post',
        data: { enabled, expectedPolicyRevision: status?.policy.revision },
      });
      message.success(enabled ? t('Automatic recovery enabled') : t('Automatic recovery disabled'));
      await refresh();
    } catch (policyError) {
      message.error(getErrorText(policyError));
    } finally {
      setSaving(false);
    }
  };

  const retry = async () => {
    const state = status?.state;
    const quarantine = state?.quarantine;
    if (!state || !quarantine) return;
    setSaving(true);
    try {
      await request({
        url: 'startupGuardian:retry',
        method: 'post',
        data: { packageName: quarantine.target.packageName, expectedRevision: state.revision },
      });
      message.success(t('Retry request accepted'));
      await refresh();
    } catch (retryError) {
      message.error(getErrorText(retryError));
    } finally {
      setSaving(false);
    }
  };

  const columns: ColumnsType<StartupIncident> = [
    {
      title: t('Plugin'),
      key: 'plugin',
      render: (_value, incident) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{incident.pluginName}</Typography.Text>
          <Typography.Text type="secondary">{incident.packageName}</Typography.Text>
          <Typography.Text type="secondary">{incident.pluginVersion}</Typography.Text>
        </Space>
      ),
    },
    { title: t('Lifecycle phase'), dataIndex: 'phase', key: 'phase' },
    {
      title: t('Failure'),
      dataIndex: 'errorMessage',
      key: 'failure',
      render: (value: string) => <Typography.Text>{value}</Typography.Text>,
    },
    {
      title: t('Fingerprint'),
      dataIndex: 'fingerprint',
      key: 'fingerprint',
      render: (value: string) => (
        <Typography.Text code copyable>
          {value}
        </Typography.Text>
      ),
    },
    {
      title: t('Observed at'),
      dataIndex: 'timestamp',
      key: 'timestamp',
      render: (value: string) => new Date(value).toLocaleString(),
    },
    {
      title: t('Policy'),
      key: 'policy',
      render: (_value, incident) => (
        <Button
          disabled={saving || !status?.policyMutationSupported || isApproved(status?.policy, incident)}
          onClick={() => approve(incident)}
          size="small"
        >
          {isApproved(status?.policy, incident) ? t('Approved') : t('Approve exact failure')}
        </Button>
      ),
    },
  ];

  if (loading && !status) return <Spin aria-label={t('Loading startup guardian')} />;

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <Typography.Title level={3}>{t('Startup Guardian')}</Typography.Title>
      <Alert
        type={status?.autoRecoverySupported ? 'info' : 'warning'}
        showIcon
        message={
          status?.mode === 'redis-postgres-app-only-ha'
            ? t('Coordinated app-only HA mode')
            : status?.autoRecoverySupported
              ? t('Single-node recovery mode')
              : t('Observe-only mode')
        }
        description={
          status?.mode === 'redis-postgres-app-only-ha'
            ? t(
                'HA policy is shared through PostgreSQL and approval uses revision checks. Retry is unavailable; all shared-database workers must remain outside this app-only roster.',
              )
            : status?.autoRecoverySupported
              ? t(
                  'Only an exact approved plugin, version, lifecycle phase and failure fingerprint can be quarantined. HA replicas and import-time failures are outside this mode.',
                )
              : t(
                  'Automatic recovery is unavailable for this database dialect. Incidents are observed without changing plugin state.',
                )
        }
      />

      {error && <Alert type="error" showIcon message={t('Request failed')} description={error} />}

      <Card
        title={t('Runtime status')}
        extra={
          <Button onClick={() => refresh()} loading={loading}>
            {t('Refresh')}
          </Button>
        }
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Space wrap>
            <Typography.Text strong>{t('State')}:</Typography.Text>
            <Tag color={status?.state?.state === 'ready' ? 'green' : 'orange'}>
              {status?.state?.state || t('Unknown')}
            </Tag>
            <Typography.Text>
              {t('Mode')}: {status?.mode || t('Unknown')}
            </Typography.Text>
            <Typography.Text>
              {t('Campaign attempts')}: {status?.state?.quarantineAttempts ?? 0}/
              {status?.state?.maxQuarantineAttempts ?? 0}
            </Typography.Text>
          </Space>
          {status?.state?.detail && <Typography.Paragraph>{status.state.detail}</Typography.Paragraph>}
          <Space>
            <Typography.Text>{t('Automatic recovery')}</Typography.Text>
            <Switch
              checked={status?.policy.autoRecoveryEnabled || false}
              disabled={saving || !status?.autoRecoverySupported}
              onChange={setAutomaticRecovery}
              aria-label={t('Automatic recovery')}
            />
          </Space>
          {status?.retrySupported && status.state?.quarantine?.status === 'quarantined' && (
            <Popconfirm
              title={t(
                'Retrying enables the quarantined plugin and restarts the supervised app. The next failure can quarantine it again.',
              )}
              okText={t('Retry plugin')}
              cancelText={t('Cancel')}
              onConfirm={() => retry()}
            >
              <Button type="primary" loading={saving}>
                {t('Retry quarantined plugin')}
              </Button>
            </Popconfirm>
          )}
        </Space>
      </Card>

      <Card title={t('Observed lifecycle failures')}>
        <Table<StartupIncident>
          aria-label={t('Observed lifecycle failures')}
          columns={columns}
          dataSource={incidents}
          rowKey="eventId"
          loading={loading}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          locale={{ emptyText: t('No lifecycle failures have been recorded') }}
          scroll={{ x: true }}
        />
      </Card>
    </Space>
  );
}

function readPayload<T>(response: unknown): T {
  const responseRecord = asRecord(response);
  const body = asRecord(responseRecord?.data);
  const payload = body?.data ?? body;
  if (!payload || typeof payload !== 'object')
    throw new Error('The server returned an invalid Startup Guardian response');
  return payload as T;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function getErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  const errorRecord = asRecord(error);
  const response = asRecord(errorRecord?.response);
  const body = asRecord(response?.data);
  const detail = body?.errors;
  if (Array.isArray(detail) && typeof asRecord(detail[0])?.message === 'string')
    return String(asRecord(detail[0])?.message);
  return typeof body?.message === 'string' ? body.message : 'Unknown error';
}

function isApproved(policy: GuardianPolicy | undefined, incident: StartupIncident): boolean {
  return Boolean(
    policy?.approvedRules.some(
      (rule: ApprovedPolicyRule) =>
        rule.pluginName === incident.pluginName &&
        rule.packageName === incident.packageName &&
        rule.pluginVersion === incident.pluginVersion &&
        rule.phase === incident.phase &&
        rule.fingerprint === incident.fingerprint,
    ),
  );
}
