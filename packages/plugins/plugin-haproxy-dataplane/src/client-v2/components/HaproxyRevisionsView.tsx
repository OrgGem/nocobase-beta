// SPDX-License-Identifier: Apache-2.0

import { CameraOutlined, CheckCircleOutlined, DiffOutlined, EyeOutlined, RollbackOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  message,
  Modal,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ConfigDiffResult,
  DiffLine,
  HaproxyAuditLogRecord,
  HaproxyConfigRevisionDetail,
  HaproxyConfigRevisionSummary,
} from '../../shared/types';
import { useHaproxyApi } from '../api';
import { useHaproxySession } from '../hooks/useHaproxySession';
import { useT } from '../locale';
import { formatBytes, getErrorMessage } from '../utils/format';
import { NodeToolbar } from './NodeToolbar';

type RevisionsSubTab = 'revisions' | 'diff' | 'audit';
type CompareMode = 'revision' | 'nodes';

const MONO_FONT = "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace";

function sourceTagColor(source: string): string {
  switch (source) {
    case 'manual_snapshot':
      return 'blue';
    case 'rollback':
      return 'purple';
    case 'raw_push':
    case 'batch_sync':
      return 'orange';
    case 'transaction_commit':
      return 'cyan';
    default:
      return 'geekblue';
  }
}

function categoryTagColor(category: string): string {
  switch (category) {
    case 'runtime':
      return 'cyan';
    case 'config':
      return 'blue';
    case 'raw':
      return 'orange';
    case 'storage':
      return 'purple';
    case 'connection':
      return 'geekblue';
    default:
      return 'default';
  }
}

function renderDiffLineStyle(type: DiffLine['type']): React.CSSProperties {
  if (type === 'add') {
    return { backgroundColor: '#f6ffed', color: '#135200' };
  }
  if (type === 'del') {
    return { backgroundColor: '#fff1f0', color: '#a8071a' };
  }
  return { backgroundColor: 'transparent', color: 'inherit' };
}

export const HaproxyRevisionsView: React.FC<{ fixedConnectionId?: number }> = ({ fixedConnectionId }) => {
  const t = useT();
  const api = useHaproxyApi();
  const { permissions, connections, selectedConnectionId, setSelectedConnectionId, bootstrapping } =
    useHaproxySession(fixedConnectionId);

  const canSnapshot = Boolean(permissions?.canConfig || permissions?.canRawConfig);
  const canRollback = Boolean(permissions?.canRawConfig);

  const [activeSubTab, setActiveSubTab] = useState<RevisionsSubTab>('revisions');
  const [loading, setLoading] = useState(false);

  // --- Revision History state ---
  const [revisions, setRevisions] = useState<HaproxyConfigRevisionSummary[]>([]);
  const [snapshotModalOpen, setSnapshotModalOpen] = useState(false);
  const [snapshotNote, setSnapshotNote] = useState('');
  const [snapshotSaving, setSnapshotSaving] = useState(false);

  const [viewingDetail, setViewingDetail] = useState<HaproxyConfigRevisionDetail | null>(null);
  const [viewingLoading, setViewingLoading] = useState(false);

  const [rollbackTarget, setRollbackTarget] = useState<HaproxyConfigRevisionSummary | null>(null);
  const [rollbackForceReload, setRollbackForceReload] = useState(false);
  const [rollbackSkipVersion, setRollbackSkipVersion] = useState(true);
  const [rollbackRunning, setRollbackRunning] = useState(false);

  // --- Visual Diff & Server Drift state ---
  const [compareMode, setCompareMode] = useState<CompareMode>('revision');
  const [leftRevisionId, setLeftRevisionId] = useState<number | null>(null);
  const [rightRevisionTarget, setRightRevisionTarget] = useState<'live' | number>('live');
  const [leftNodeId, setLeftNodeId] = useState<number | null>(null);
  const [rightNodeId, setRightNodeId] = useState<number | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffResult, setDiffResult] = useState<ConfigDiffResult | null>(null);
  const [showChangedOnly, setShowChangedOnly] = useState(false);

  // --- Audit Trail state ---
  const [auditLogs, setAuditLogs] = useState<HaproxyAuditLogRecord[]>([]);
  const [auditCategory, setAuditCategory] = useState<string>('__all__');
  const [auditTargetFilter, setAuditTargetFilter] = useState('');

  const loadData = useCallback(async () => {
    if (!selectedConnectionId) return;
    setLoading(true);
    try {
      const [revRows, auditRows] = await Promise.all([
        api.listRevisions(selectedConnectionId),
        api.listAuditLogs({ connectionId: selectedConnectionId, category: auditCategory }),
      ]);
      setRevisions(revRows);
      setAuditLogs(auditRows);
      setLeftRevisionId((prev) => {
        if (prev && revRows.some((r) => r.id === prev)) {
          return prev;
        }
        return revRows[0]?.id ?? null;
      });
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [api, auditCategory, selectedConnectionId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (connections.length === 0) return;
    setLeftNodeId((prev) => {
      if (prev && connections.some((c) => c.id === prev)) return prev;
      return selectedConnectionId ?? connections[0]?.id ?? null;
    });
    setRightNodeId((prev) => {
      if (prev && connections.some((c) => c.id === prev)) return prev;
      const anchor = selectedConnectionId ?? connections[0]?.id ?? null;
      const other = connections.find((c) => c.id !== anchor);
      return other?.id ?? connections[0]?.id ?? null;
    });
  }, [connections, selectedConnectionId]);

  const handleTakeSnapshot = useCallback(async () => {
    if (!selectedConnectionId) return;
    setSnapshotSaving(true);
    try {
      await api.createSnapshot(selectedConnectionId, snapshotNote.trim() || undefined);
      message.success(t('Snapshot saved'));
      setSnapshotModalOpen(false);
      setSnapshotNote('');
      await loadData();
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setSnapshotSaving(false);
    }
  }, [api, loadData, selectedConnectionId, snapshotNote, t]);

  const handleViewRevision = useCallback(
    async (revisionId: number) => {
      setViewingLoading(true);
      try {
        const detail = await api.getRevision(revisionId);
        setViewingDetail(detail);
      } catch (err) {
        message.error(getErrorMessage(err));
      } finally {
        setViewingLoading(false);
      }
    },
    [api],
  );

  const runRevisionDiff = useCallback(
    async (leftId: number, rightTarget: 'live' | number) => {
      setDiffLoading(true);
      try {
        const result = await api.diffRevisions(
          leftId,
          rightTarget,
          rightTarget === 'live' ? selectedConnectionId ?? undefined : undefined,
        );
        setDiffResult(result);
      } catch (err) {
        message.error(getErrorMessage(err));
      } finally {
        setDiffLoading(false);
      }
    },
    [api, selectedConnectionId],
  );

  const runLiveNodesDiff = useCallback(
    async (leftConn: number, rightConn: number) => {
      setDiffLoading(true);
      try {
        const result = await api.diffLiveNodes(leftConn, rightConn);
        setDiffResult(result);
      } catch (err) {
        message.error(getErrorMessage(err));
      } finally {
        setDiffLoading(false);
      }
    },
    [api],
  );

  const handleCompare = useCallback(async () => {
    if (compareMode === 'revision') {
      if (!leftRevisionId) return;
      await runRevisionDiff(leftRevisionId, rightRevisionTarget);
    } else {
      if (!leftNodeId || !rightNodeId) return;
      await runLiveNodesDiff(leftNodeId, rightNodeId);
    }
  }, [compareMode, leftNodeId, leftRevisionId, rightNodeId, rightRevisionTarget, runLiveNodesDiff, runRevisionDiff]);

  const handleQuickDiffWithLive = useCallback(
    async (row: HaproxyConfigRevisionSummary) => {
      setActiveSubTab('diff');
      setCompareMode('revision');
      setLeftRevisionId(row.id);
      setRightRevisionTarget('live');
      await runRevisionDiff(row.id, 'live');
    },
    [runRevisionDiff],
  );

  const handleConfirmRollback = useCallback(async () => {
    if (!rollbackTarget) return;
    setRollbackRunning(true);
    try {
      await api.rollbackRevision(rollbackTarget.id, {
        forceReload: rollbackForceReload,
        skipVersion: rollbackSkipVersion,
      });
      message.success(t('Rolled back to revision #{{id}}', { id: rollbackTarget.id }));
      setRollbackTarget(null);
      await loadData();
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setRollbackRunning(false);
    }
  }, [api, loadData, rollbackForceReload, rollbackSkipVersion, rollbackTarget, t]);

  const visibleDiffLines = useMemo(() => {
    if (!diffResult) return [];
    if (!showChangedOnly) return diffResult.lines;
    return diffResult.lines.filter((line) => line.type !== 'context');
  }, [diffResult, showChangedOnly]);

  const filteredAuditLogs = useMemo(() => {
    const keyword = auditTargetFilter.trim().toLowerCase();
    if (!keyword) return auditLogs;
    return auditLogs.filter((row) => {
      const targetStr = (row.target ?? '').toLowerCase();
      const actionStr = row.action.toLowerCase();
      return targetStr.includes(keyword) || actionStr.includes(keyword);
    });
  }, [auditLogs, auditTargetFilter]);

  if (!bootstrapping && connections.length === 0) {
    return (
      <Card>
        <Empty description={t('No enabled HAProxy Data Plane connections')} />
      </Card>
    );
  }

  const revisionSelectOptions = revisions.map((rev) => ({
    value: rev.id,
    label: `#${rev.id} (${rev.configVersion != null ? `v${rev.configVersion}` : '—'}) — ${rev.source}${
      rev.summary ? `: ${rev.summary}` : ''
    }`,
  }));

  const targetSelectOptions = [{ value: 'live' as const, label: t('Live Running Config') }, ...revisionSelectOptions];

  const nodeSelectOptions = connections.map((conn) => ({
    value: conn.id,
    label: conn.title ? `${conn.title} (${conn.name})` : conn.name,
  }));

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <NodeToolbar
        connections={connections}
        selectedConnectionId={selectedConnectionId}
        onSelectConnection={setSelectedConnectionId}
        fixedConnectionId={fixedConnectionId}
        loading={loading}
        onRefresh={loadData}
        extraRight={
          canSnapshot ? (
            <Button
              htmlType="button"
              type="primary"
              icon={<CameraOutlined aria-hidden="true" />}
              onClick={() => setSnapshotModalOpen(true)}
            >
              {t('Take Snapshot')}
            </Button>
          ) : null
        }
      />

      <Tabs
        activeKey={activeSubTab}
        onChange={(key) => setActiveSubTab(key as RevisionsSubTab)}
        items={[
          {
            key: 'revisions',
            label: t('Revision History'),
            children: (
              <Card size="small">
                <Table<HaproxyConfigRevisionSummary>
                  rowKey="id"
                  size="small"
                  loading={loading || viewingLoading}
                  dataSource={revisions}
                  pagination={{ pageSize: 15, hideOnSinglePage: true }}
                  columns={[
                    {
                      title: '#',
                      dataIndex: 'id',
                      key: 'id',
                      width: 72,
                      render: (id: number) => <Typography.Text strong>#{id}</Typography.Text>,
                    },
                    {
                      title: t('Config Version'),
                      dataIndex: 'configVersion',
                      key: 'configVersion',
                      width: 110,
                      render: (ver: number | null) => (ver != null ? <Tag>v{ver}</Tag> : '—'),
                    },
                    {
                      title: t('Source'),
                      dataIndex: 'source',
                      key: 'source',
                      width: 150,
                      render: (source: string) => <Tag color={sourceTagColor(source)}>{source}</Tag>,
                    },
                    {
                      title: t('Summary'),
                      dataIndex: 'summary',
                      key: 'summary',
                      render: (summary: string | null) => summary || '—',
                    },
                    {
                      title: t('Lines / Size'),
                      key: 'size',
                      width: 140,
                      render: (_v: unknown, row: HaproxyConfigRevisionSummary) =>
                        `${row.lineCount} / ${formatBytes(row.byteSize)}`,
                    },
                    {
                      title: t('Operator'),
                      dataIndex: 'actorName',
                      key: 'actorName',
                      width: 130,
                      render: (actorName: string | null) => actorName || '—',
                    },
                    {
                      title: t('Created At'),
                      dataIndex: 'createdAt',
                      key: 'createdAt',
                      width: 180,
                      render: (ts: string | null) => (ts ? new Date(ts).toLocaleString() : '—'),
                    },
                    {
                      title: t('Actions'),
                      key: 'actions',
                      width: canRollback ? 300 : 200,
                      render: (_v: unknown, row: HaproxyConfigRevisionSummary) => (
                        <Space size={6} wrap>
                          <Button
                            htmlType="button"
                            size="small"
                            icon={<EyeOutlined aria-hidden="true" />}
                            aria-label={`${t('View')} #${row.id}`}
                            onClick={() => handleViewRevision(row.id)}
                          >
                            {t('View')}
                          </Button>
                          <Button
                            htmlType="button"
                            size="small"
                            icon={<DiffOutlined aria-hidden="true" />}
                            aria-label={`${t('Diff with Live')} #${row.id}`}
                            onClick={() => handleQuickDiffWithLive(row)}
                          >
                            {t('Diff with Live')}
                          </Button>
                          {canRollback && (
                            <Button
                              htmlType="button"
                              size="small"
                              danger
                              icon={<RollbackOutlined aria-hidden="true" />}
                              aria-label={`${t('Rollback')} #${row.id}`}
                              onClick={() => setRollbackTarget(row)}
                            >
                              {t('Rollback')}
                            </Button>
                          )}
                        </Space>
                      ),
                    },
                  ]}
                />
              </Card>
            ),
          },
          {
            key: 'diff',
            label: t('Visual Diff & Server Drift'),
            children: (
              <Card size="small">
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Space wrap>
                    <Typography.Text strong>{t('Compare Mode')}:</Typography.Text>
                    <Radio.Group
                      value={compareMode}
                      onChange={(e) => {
                        setCompareMode(e.target.value as CompareMode);
                        setDiffResult(null);
                      }}
                      optionType="button"
                      buttonStyle="solid"
                      options={[
                        { value: 'revision', label: t('Revision vs Live / Revision') },
                        ...(!fixedConnectionId
                          ? [{ value: 'nodes', label: t('Server A vs Server B (Live Drift)') }]
                          : []),
                      ]}
                    />
                  </Space>

                  {compareMode === 'revision' ? (
                    <Space wrap>
                      <Typography.Text>{t('Base Revision')}:</Typography.Text>
                      <Select
                        style={{ minWidth: 280 }}
                        aria-label={t('Base Revision')}
                        value={leftRevisionId ?? undefined}
                        onChange={(val: number) => setLeftRevisionId(val)}
                        options={revisionSelectOptions}
                      />
                      <Typography.Text>{t('Target (Live or Revision)')}:</Typography.Text>
                      <Select
                        style={{ minWidth: 280 }}
                        aria-label={t('Target (Live or Revision)')}
                        value={rightRevisionTarget}
                        onChange={(val: 'live' | number) => setRightRevisionTarget(val)}
                        options={targetSelectOptions}
                      />
                      <Button
                        htmlType="button"
                        type="primary"
                        icon={<DiffOutlined aria-hidden="true" />}
                        loading={diffLoading}
                        disabled={!leftRevisionId}
                        onClick={handleCompare}
                      >
                        {t('Compare')}
                      </Button>
                    </Space>
                  ) : (
                    <Space wrap>
                      <Typography.Text>{t('Server A')}:</Typography.Text>
                      <Select
                        style={{ minWidth: 230 }}
                        aria-label={t('Server A')}
                        value={leftNodeId ?? undefined}
                        onChange={(val: number) => setLeftNodeId(val)}
                        options={nodeSelectOptions}
                      />
                      <Typography.Text>{t('Server B')}:</Typography.Text>
                      <Select
                        style={{ minWidth: 230 }}
                        aria-label={t('Server B')}
                        value={rightNodeId ?? undefined}
                        onChange={(val: number) => setRightNodeId(val)}
                        options={nodeSelectOptions}
                      />
                      <Button
                        htmlType="button"
                        type="primary"
                        icon={<DiffOutlined aria-hidden="true" />}
                        loading={diffLoading}
                        disabled={!leftNodeId || !rightNodeId}
                        onClick={handleCompare}
                      >
                        {t('Compare')}
                      </Button>
                    </Space>
                  )}

                  {diffResult && (
                    <Space direction="vertical" size={10} style={{ width: '100%' }}>
                      <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
                        <Space wrap>
                          <Tag>{diffResult.leftLabel}</Tag>
                          <Typography.Text type="secondary">→</Typography.Text>
                          <Tag color="blue">{diffResult.rightLabel}</Tag>
                          {diffResult.identical ? (
                            <Tag icon={<CheckCircleOutlined aria-hidden="true" />} color="success">
                              {t('Identical (No Drift)')}
                            </Tag>
                          ) : (
                            <>
                              <Tag color="success">+{diffResult.addedCount}</Tag>
                              <Tag color="error">-{diffResult.deletedCount}</Tag>
                            </>
                          )}
                        </Space>
                        <Space>
                          <Switch
                            checked={showChangedOnly}
                            onChange={setShowChangedOnly}
                            aria-label={t('Show changed lines only')}
                          />
                          <Typography.Text>{t('Show changed lines only')}</Typography.Text>
                        </Space>
                      </Space>

                      {diffResult.truncated && (
                        <Alert
                          type="warning"
                          showIcon
                          message={t('Diff output was truncated to protect browser performance.')}
                        />
                      )}

                      {!diffResult.identical && (
                        <div
                          role="region"
                          aria-label={t('Visual Diff & Server Drift')}
                          tabIndex={0}
                          style={{
                            fontFamily: MONO_FONT,
                            fontSize: 12,
                            lineHeight: '20px',
                            maxHeight: 520,
                            overflow: 'auto',
                            border: '1px solid #d9d9d9',
                            borderRadius: 6,
                          }}
                        >
                          {visibleDiffLines.map((line, idx) => {
                            const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
                            return (
                              <div
                                key={`${line.oldLineNumber ?? 'n'}-${line.newLineNumber ?? 'n'}-${idx}`}
                                style={{
                                  display: 'flex',
                                  padding: '0 8px',
                                  ...renderDiffLineStyle(line.type),
                                }}
                              >
                                <span
                                  style={{
                                    width: 44,
                                    textAlign: 'right',
                                    paddingRight: 8,
                                    opacity: 0.6,
                                    userSelect: 'none',
                                    flexShrink: 0,
                                  }}
                                >
                                  {line.oldLineNumber ?? ''}
                                </span>
                                <span
                                  style={{
                                    width: 44,
                                    textAlign: 'right',
                                    paddingRight: 8,
                                    opacity: 0.6,
                                    userSelect: 'none',
                                    flexShrink: 0,
                                  }}
                                >
                                  {line.newLineNumber ?? ''}
                                </span>
                                <span style={{ width: 16, userSelect: 'none', flexShrink: 0, fontWeight: 600 }}>
                                  {prefix}
                                </span>
                                <span style={{ whiteSpace: 'pre' }}>{line.content}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </Space>
                  )}
                </Space>
              </Card>
            ),
          },
          {
            key: 'audit',
            label: t('Audit Trail'),
            children: (
              <Card
                size="small"
                extra={
                  <Space wrap>
                    <Typography.Text>{t('Category')}:</Typography.Text>
                    <Select
                      style={{ minWidth: 160 }}
                      aria-label={t('Category')}
                      value={auditCategory}
                      onChange={(val: string) => setAuditCategory(val)}
                      options={[
                        { value: '__all__', label: t('All categories') },
                        { value: 'runtime', label: 'runtime' },
                        { value: 'config', label: 'config' },
                        { value: 'raw', label: 'raw' },
                        { value: 'storage', label: 'storage' },
                        { value: 'connection', label: 'connection' },
                      ]}
                    />
                    <Input
                      allowClear
                      style={{ width: 210 }}
                      placeholder={t('Target')}
                      aria-label={t('Target')}
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      value={auditTargetFilter}
                      onChange={(e) => setAuditTargetFilter(e.target.value)}
                    />
                  </Space>
                }
              >
                <Table<HaproxyAuditLogRecord>
                  rowKey="id"
                  size="small"
                  loading={loading}
                  dataSource={filteredAuditLogs}
                  pagination={{ pageSize: 20, hideOnSinglePage: true }}
                  columns={[
                    {
                      title: t('Created At'),
                      dataIndex: 'createdAt',
                      key: 'createdAt',
                      width: 180,
                      render: (ts: string | null) => (ts ? new Date(ts).toLocaleString() : '—'),
                    },
                    {
                      title: t('Operator'),
                      dataIndex: 'actorName',
                      key: 'actorName',
                      width: 130,
                      render: (actorName: string | null) => actorName || '—',
                    },
                    {
                      title: t('Category'),
                      dataIndex: 'category',
                      key: 'category',
                      width: 115,
                      render: (cat: string) => <Tag color={categoryTagColor(cat)}>{cat}</Tag>,
                    },
                    {
                      title: t('Action'),
                      dataIndex: 'action',
                      key: 'action',
                      width: 210,
                      render: (action: string) => <Typography.Text code>{action}</Typography.Text>,
                    },
                    {
                      title: t('Target'),
                      dataIndex: 'target',
                      key: 'target',
                      width: 180,
                      render: (target: string | null) => target || '—',
                    },
                    {
                      title: t('Status'),
                      dataIndex: 'status',
                      key: 'status',
                      width: 100,
                      render: (status: string) => <Tag color={status === 'failed' ? 'error' : 'success'}>{status}</Tag>,
                    },
                    {
                      title: t('Detail'),
                      dataIndex: 'detail',
                      key: 'detail',
                      render: (detail: string | null) => detail || '—',
                    },
                  ]}
                />
              </Card>
            ),
          },
        ]}
      />

      {/* Manual Snapshot Modal */}
      <Modal
        open={snapshotModalOpen}
        title={t('Take Snapshot')}
        okText={t('Save')}
        cancelText={t('Cancel')}
        confirmLoading={snapshotSaving}
        onOk={handleTakeSnapshot}
        onCancel={() => setSnapshotModalOpen(false)}
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text>{t('Snapshot Note')}</Typography.Text>
          <Input
            placeholder={t('Optional summary note for this snapshot')}
            aria-label={t('Snapshot Note')}
            value={snapshotNote}
            maxLength={255}
            onChange={(e) => setSnapshotNote(e.target.value)}
          />
        </Space>
      </Modal>

      {/* View Raw Revision Modal */}
      <Modal
        open={Boolean(viewingDetail)}
        title={
          viewingDetail
            ? `#${viewingDetail.id} — ${viewingDetail.connectionName}${
                viewingDetail.configVersion != null ? ` (v${viewingDetail.configVersion})` : ''
              }`
            : ''
        }
        width={820}
        footer={null}
        onCancel={() => setViewingDetail(null)}
      >
        {viewingDetail && (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Space wrap>
              <Tag color={sourceTagColor(viewingDetail.source)}>{viewingDetail.source}</Tag>
              {viewingDetail.checksum && (
                <Typography.Text type="secondary">
                  {t('Checksum')}: <Typography.Text code>{viewingDetail.checksum}</Typography.Text>
                </Typography.Text>
              )}
              <Typography.Text type="secondary">
                {viewingDetail.lineCount} / {formatBytes(viewingDetail.byteSize)}
              </Typography.Text>
            </Space>
            <pre
              tabIndex={0}
              style={{
                fontFamily: MONO_FONT,
                fontSize: 12,
                maxHeight: 480,
                overflow: 'auto',
                padding: 12,
                margin: 0,
                background: '#fafafa',
                border: '1px solid #d9d9d9',
                borderRadius: 6,
              }}
            >
              {viewingDetail.rawContent}
            </pre>
          </Space>
        )}
      </Modal>

      {/* Rollback Confirmation Modal */}
      <Modal
        open={Boolean(rollbackTarget)}
        title={rollbackTarget ? t('Rollback to Revision #{{id}}', { id: rollbackTarget.id }) : ''}
        okText={t('Rollback')}
        okButtonProps={{ danger: true }}
        cancelText={t('Cancel')}
        confirmLoading={rollbackRunning}
        onOk={handleConfirmRollback}
        onCancel={() => setRollbackTarget(null)}
      >
        {rollbackTarget && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message={t('Data Plane API validates syntax before writing haproxy.cfg and reloading HAProxy.')}
            />
            <Space wrap>
              <Tag>#{rollbackTarget.id}</Tag>
              {rollbackTarget.configVersion != null && <Tag>v{rollbackTarget.configVersion}</Tag>}
              <Tag color={sourceTagColor(rollbackTarget.source)}>{rollbackTarget.source}</Tag>
              {rollbackTarget.summary && <Typography.Text>{rollbackTarget.summary}</Typography.Text>}
            </Space>
            <Space>
              <Switch
                checked={rollbackSkipVersion}
                onChange={setRollbackSkipVersion}
                aria-label={t('Skip optimistic version check (overwrite target version)')}
              />
              <Typography.Text>{t('Skip optimistic version check (overwrite target version)')}</Typography.Text>
            </Space>
            <Space>
              <Switch
                checked={rollbackForceReload}
                onChange={setRollbackForceReload}
                aria-label={t('Force immediate reload (skip reload-delay)')}
              />
              <Typography.Text>{t('Force immediate reload (skip reload-delay)')}</Typography.Text>
            </Space>
          </Space>
        )}
      </Modal>
    </Space>
  );
};

export default HaproxyRevisionsView;
