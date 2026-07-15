import React, { useEffect, useState, useCallback, memo } from 'react';
import {
  Table,
  Empty,
  Spin,
  Typography,
  Tag,
  Drawer,
  Space,
  Avatar,
  Select,
  Button,
  Tooltip,
  Input,
  Badge,
  Tabs,
  Divider,
  theme,
} from 'antd';
import {
  MergeOutlined,
  BranchesOutlined,
  UserOutlined,
  ClockCircleOutlined,
  CommentOutlined,
  ExportOutlined,
  SearchOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  FileTextOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useGitManager } from '../context/GitManagerContext';
import { RunReviewButton } from './RunReviewButton';
import { useT } from '../locale';

const { Text, Paragraph, Title } = Typography;
const { useToken } = theme;

const STATE_CONFIG: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
  opened: { color: 'blue', icon: <MergeOutlined />, label: 'Open' },
  merged: { color: 'purple', icon: <CheckCircleOutlined />, label: 'Merged' },
  closed: { color: 'red', icon: <CloseCircleOutlined />, label: 'Closed' },
};

export const MergeRequests: React.FC = () => {
  const t = useT();
  const { token } = useToken();
  const api = useApp().apiClient;
  const { selectedRepo } = useGitManager();
  const [mergeRequestsList, setMergeRequestsList] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [stateFilter, setStateFilter] = useState('opened');
  const [searchText, setSearchText] = useState('');
  const [pagination, setPagination] = useState({ page: 1, perPage: 20, total: 0, totalPages: 0 });
  const [selectedMR, setSelectedMR] = useState<any>(null);
  const [mrDetail, setMrDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [notes, setNotes] = useState<any[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);

  const loadMergeRequests = useCallback(
    async (page = 1) => {
      if (!selectedRepo) return;
      setLoading(true);
      try {
        const { data } = await api.request({
          url: 'gitManager:mergeRequests',
          params: {
            repositoryId: selectedRepo.id,
            state: stateFilter,
            search: searchText || undefined,
            page,
            perPage: 20,
          },
        });
        const responseData = data?.data || data;
        setMergeRequestsList(responseData?.data || []);
        if (responseData?.pagination) {
          setPagination(responseData.pagination);
        }
      } catch (err: any) {
        setMergeRequestsList([]);
      } finally {
        setLoading(false);
      }
    },
    [api, selectedRepo, stateFilter, searchText],
  );

  useEffect(() => {
    if (selectedRepo?.status === 'connected') {
      loadMergeRequests(1);
    } else {
      setMergeRequestsList([]);
    }
  }, [selectedRepo, stateFilter]);

  const handleSearch = () => {
    loadMergeRequests(1);
  };

  const openMRDetail = async (mr: any) => {
    setSelectedMR(mr);
    setDetailLoading(true);
    setNotes([]);
    try {
      const [detailRes, notesRes] = await Promise.all([
        api.request({
          url: 'gitManager:mergeRequestDetail',
          params: { repositoryId: selectedRepo!.id, mrIid: mr.iid },
        }),
        api.request({
          url: 'gitManager:mergeRequestNotes',
          params: { repositoryId: selectedRepo!.id, mrIid: mr.iid },
        }),
      ]);
      const detailData = detailRes?.data?.data?.data || detailRes?.data?.data;
      setMrDetail(detailData);
      const notesData = notesRes?.data?.data?.data || notesRes?.data?.data;
      setNotes(Array.isArray(notesData) ? notesData : []);
    } catch {
      setMrDetail(null);
    } finally {
      setDetailLoading(false);
    }
  };

  if (!selectedRepo) {
    return <Empty description={t('No repository selected')} />;
  }
  if (selectedRepo.status !== 'connected') {
    return <Empty description={t('Repository not cloned yet')} />;
  }

  const columns = [
    {
      title: '',
      key: 'state_icon',
      width: 40,
      render: (_: any, record: any) => {
        const cfg = STATE_CONFIG[record.state] || STATE_CONFIG.opened;
        return (
          <Tooltip title={cfg.label}>
            <span
              style={{
                color:
                  token[`color${cfg.color === 'blue' ? 'Primary' : cfg.color === 'purple' ? 'PurpleText' : 'Error'}`] ||
                  cfg.color,
                fontSize: 16,
              }}
            >
              {cfg.icon}
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: t('Title'),
      key: 'title',
      render: (_: any, record: any) => (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {record.draft && (
              <Tag color="default" style={{ fontSize: 11, lineHeight: '16px' }}>
                DRAFT
              </Tag>
            )}
            <Text strong style={{ fontSize: 13 }}>
              {record.title}
            </Text>
            {record.hasConflicts && (
              <Tooltip title={t('Has conflicts')}>
                <ExclamationCircleOutlined style={{ color: token.colorWarning }} />
              </Tooltip>
            )}
          </div>
          <div style={{ marginTop: 2 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              !{record.iid}
              <span style={{ margin: '0 6px' }}>·</span>
              <UserOutlined style={{ marginRight: 3 }} />
              {record.author?.name || record.author?.username || 'Unknown'}
              <span style={{ margin: '0 6px' }}>·</span>
              <ClockCircleOutlined style={{ marginRight: 3 }} />
              {formatDate(record.updatedAt)}
            </Text>
          </div>
        </div>
      ),
    },
    {
      title: '',
      key: 'branches',
      width: 250,
      render: (_: any, record: any) => (
        <div style={{ fontSize: 12 }}>
          <Tag color="blue" style={{ fontSize: 11 }}>
            <BranchesOutlined /> {record.sourceBranch}
          </Tag>
          <span style={{ margin: '0 4px', color: token.colorTextSecondary }}>→</span>
          <Tag color="green" style={{ fontSize: 11 }}>
            <BranchesOutlined /> {record.targetBranch}
          </Tag>
        </div>
      ),
    },
    {
      title: '',
      key: 'labels',
      width: 180,
      render: (_: any, record: any) => (
        <Space size={2} wrap>
          {(record.labels || []).slice(0, 3).map((label: string) => (
            <Tag key={label} style={{ fontSize: 11 }}>
              {label}
            </Tag>
          ))}
          {record.labels?.length > 3 && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              +{record.labels.length - 3}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: '',
      key: 'meta',
      width: 120,
      render: (_: any, record: any) => (
        <Space size={12}>
          {record.userNotesCount > 0 && (
            <Tooltip title={`${record.userNotesCount} comments`}>
              <Badge count={record.userNotesCount} size="small" color={token.colorTextSecondary}>
                <CommentOutlined style={{ fontSize: 14, color: token.colorTextSecondary }} />
              </Badge>
            </Tooltip>
          )}
          {record.assignees?.length > 0 && (
            <Avatar.Group size="small" max={{ count: 2 }}>
              {record.assignees.map((a: any) => (
                <Tooltip key={a.username} title={a.name}>
                  <Avatar size="small" src={a.avatarUrl}>
                    {a.name?.[0]}
                  </Avatar>
                </Tooltip>
              ))}
            </Avatar.Group>
          )}
        </Space>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 160,
      render: (_: any, record: any) => (
        <Space onClick={(e) => e.stopPropagation()}>
          <RunReviewButton
            target={{ type: 'mr', repositoryId: selectedRepo!.id, mrIid: record.iid, title: record.title }}
            size="small"
          />
          <Tooltip title={t('View Details')}>
            <Button
              size="small"
              icon={<FileTextOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                openMRDetail(record);
              }}
            />
          </Tooltip>
          <Tooltip title={t('Open in GitLab')}>
            <Button
              size="small"
              icon={<ExportOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                window.open(record.webUrl, '_blank');
              }}
            />
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <div>
      {/* Filters bar */}
      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Select
          size="small"
          style={{ width: 140 }}
          value={stateFilter}
          onChange={(v) => setStateFilter(v)}
          options={[
            { label: `🟢 ${t('Open')}`, value: 'opened' },
            { label: `🟣 ${t('Merged')}`, value: 'merged' },
            { label: `🔴 ${t('Closed')}`, value: 'closed' },
            { label: `📋 ${t('All')}`, value: 'all' },
          ]}
        />
        <Input.Search
          size="small"
          style={{ width: 260 }}
          placeholder={t('Search merge requests...')}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onSearch={handleSearch}
          allowClear
        />
        <Button size="small" icon={<ReloadOutlined />} onClick={() => loadMergeRequests(1)}>
          {t('Refresh')}
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {pagination.total != null ? `${pagination.total} ${t('total')}` : ''}
        </Text>
      </div>

      {loading ? (
        <Spin />
      ) : (
        <Table
          dataSource={mergeRequestsList}
          columns={columns}
          rowKey="iid"
          size="small"
          pagination={{
            current: pagination.page,
            pageSize: pagination.perPage,
            total: pagination.total || undefined,
            onChange: (page) => loadMergeRequests(page),
            showSizeChanger: false,
          }}
          onRow={(record) => ({
            style: { cursor: 'pointer' },
            onClick: () => openMRDetail(record),
          })}
        />
      )}

      {/* MR Detail Drawer */}
      <Drawer
        title={
          selectedMR ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {(() => {
                  const cfg = STATE_CONFIG[selectedMR.state] || STATE_CONFIG.opened;
                  return (
                    <Tag color={cfg.color}>
                      {cfg.icon} {cfg.label}
                    </Tag>
                  );
                })()}
                {selectedMR.draft && <Tag>DRAFT</Tag>}
                <Text strong style={{ fontSize: 15 }}>
                  !{selectedMR.iid}
                </Text>
              </div>
              <Text strong style={{ fontSize: 16, display: 'block', marginTop: 4 }}>
                {selectedMR.title}
              </Text>
            </div>
          ) : (
            t('Merge Request')
          )
        }
        open={!!selectedMR}
        onClose={() => {
          setSelectedMR(null);
          setMrDetail(null);
          setNotes([]);
        }}
        width={900}
        extra={
          selectedMR && (
            <Space>
              <RunReviewButton
                target={{
                  type: 'mr',
                  repositoryId: selectedRepo!.id,
                  mrIid: selectedMR.iid,
                  title: selectedMR.title,
                }}
                size="small"
              />
              <Button type="link" icon={<ExportOutlined />} onClick={() => window.open(selectedMR.webUrl, '_blank')}>
                {t('Open in GitLab')}
              </Button>
            </Space>
          )
        }
      >
        {detailLoading ? (
          <Spin />
        ) : mrDetail ? (
          <Tabs
            defaultActiveKey="overview"
            items={[
              {
                key: 'overview',
                label: t('Overview'),
                children: <MROverview mr={mrDetail} />,
              },
              {
                key: 'changes',
                label: `${t('Changes')} (${mrDetail.changes?.length || 0})`,
                children: <MRChanges changes={mrDetail.changes || []} />,
              },
              {
                key: 'comments',
                label: (
                  <Badge count={notes.length} size="small" offset={[6, 0]}>
                    {t('Comments')}
                  </Badge>
                ),
                children: <MRNotes notes={notes} />,
              },
            ]}
          />
        ) : null}
      </Drawer>
    </div>
  );
};

/* ─── Sub-components ─── */

const MROverview: React.FC<{ mr: any }> = ({ mr }) => {
  const t = useT();
  const { token } = useToken();

  return (
    <div>
      {/* Branch info */}
      <div
        style={{
          padding: '12px 16px',
          background: token.colorBgLayout,
          borderRadius: 8,
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Tag color="blue">
          <BranchesOutlined /> {mr.sourceBranch}
        </Tag>
        <span style={{ color: token.colorTextSecondary, fontSize: 16 }}>→</span>
        <Tag color="green">
          <BranchesOutlined /> {mr.targetBranch}
        </Tag>
        {mr.hasConflicts && (
          <Tag color="warning" icon={<ExclamationCircleOutlined />}>
            {t('Has conflicts')}
          </Tag>
        )}
      </div>

      {/* Description */}
      {mr.description && (
        <div style={{ marginBottom: 16 }}>
          <Text strong>{t('Description')}</Text>
          <div
            style={{
              marginTop: 8,
              padding: '12px 16px',
              background: token.colorBgLayout,
              borderRadius: 8,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            {mr.description}
          </div>
        </div>
      )}

      {/* Metadata grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '12px 24px',
          fontSize: 13,
        }}
      >
        <MetaItem
          label={t('Author')}
          value={
            mr.author && (
              <Space size={6}>
                <Avatar size="small" src={mr.author.avatarUrl}>
                  {mr.author.name?.[0]}
                </Avatar>
                <Text>{mr.author.name}</Text>
                <Text type="secondary">@{mr.author.username}</Text>
              </Space>
            )
          }
        />

        <MetaItem
          label={t('Assignees')}
          value={
            mr.assignees?.length > 0 ? (
              <Space size={4} wrap>
                {mr.assignees.map((a: any) => (
                  <Tooltip key={a.username} title={a.name}>
                    <Tag
                      icon={
                        <Avatar size={14} src={a.avatarUrl}>
                          {a.name?.[0]}
                        </Avatar>
                      }
                    >
                      {a.name}
                    </Tag>
                  </Tooltip>
                ))}
              </Space>
            ) : (
              <Text type="secondary">—</Text>
            )
          }
        />

        <MetaItem
          label={t('Reviewers')}
          value={
            mr.reviewers?.length > 0 ? (
              <Space size={4} wrap>
                {mr.reviewers.map((r: any) => (
                  <Tag key={r.username}>{r.name}</Tag>
                ))}
              </Space>
            ) : (
              <Text type="secondary">—</Text>
            )
          }
        />

        <MetaItem
          label={t('Labels')}
          value={
            mr.labels?.length > 0 ? (
              <Space size={4} wrap>
                {mr.labels.map((l: string) => (
                  <Tag key={l}>{l}</Tag>
                ))}
              </Space>
            ) : (
              <Text type="secondary">—</Text>
            )
          }
        />

        <MetaItem label={t('Created')} value={<Text>{formatDateFull(mr.createdAt)}</Text>} />
        <MetaItem label={t('Updated')} value={<Text>{formatDateFull(mr.updatedAt)}</Text>} />

        {mr.mergedBy && (
          <MetaItem
            label={t('Merged by')}
            value={
              <Text>
                {mr.mergedBy.name} — {formatDateFull(mr.mergedAt)}
              </Text>
            }
          />
        )}
        {mr.closedBy && (
          <MetaItem
            label={t('Closed by')}
            value={
              <Text>
                {mr.closedBy.name} — {formatDateFull(mr.closedAt)}
              </Text>
            }
          />
        )}
      </div>
    </div>
  );
};

const MetaItem: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div>
    <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 2 }}>
      {label}
    </Text>
    <div>{value}</div>
  </div>
);

const MRChanges: React.FC<{ changes: any[] }> = ({ changes }) => {
  const { token } = useToken();
  const t = useT();
  const [expandedFile, setExpandedFile] = useState<string | null>(null);

  if (!changes.length) {
    return <Empty description={t('No changes')} />;
  }

  return (
    <div>
      {changes.map((change, idx) => {
        const filePath = change.newPath || change.oldPath;
        const isExpanded = expandedFile === filePath;
        let statusTag: React.ReactNode = null;
        if (change.newFile) statusTag = <Tag color="green">NEW</Tag>;
        else if (change.deletedFile) statusTag = <Tag color="red">DEL</Tag>;
        else if (change.renamedFile) statusTag = <Tag color="orange">RENAMED</Tag>;
        else statusTag = <Tag color="blue">MOD</Tag>;

        return (
          <div key={idx} style={{ marginBottom: 8 }}>
            <div
              style={{
                padding: '6px 12px',
                background: isExpanded ? token.colorPrimaryBg : token.colorBgLayout,
                borderRadius: 6,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
              onClick={() => setExpandedFile(isExpanded ? null : filePath)}
            >
              {statusTag}
              <Text style={{ fontSize: 13, fontFamily: 'monospace' }}>{filePath}</Text>
              {change.renamedFile && change.oldPath !== change.newPath && (
                <Text type="secondary" style={{ fontSize: 11 }}>
                  (← {change.oldPath})
                </Text>
              )}
            </div>
            {isExpanded && change.diff && <DiffViewer content={change.diff} />}
          </div>
        );
      })}
    </div>
  );
};

const MRNotes: React.FC<{ notes: any[] }> = ({ notes }) => {
  const { token } = useToken();
  const t = useT();

  if (!notes.length) {
    return <Empty description={t('No comments')} />;
  }

  return (
    <div>
      {notes.map((note) => (
        <div
          key={note.id}
          style={{
            padding: '12px 16px',
            marginBottom: 12,
            background: token.colorBgLayout,
            borderRadius: 8,
            borderLeft: `3px solid ${note.resolved ? token.colorSuccess : token.colorBorderSecondary}`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Avatar size="small" src={note.author?.avatarUrl}>
              {note.author?.name?.[0]}
            </Avatar>
            <Text strong style={{ fontSize: 13 }}>
              {note.author?.name}
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              @{note.author?.username}
            </Text>
            <Text type="secondary" style={{ fontSize: 11, marginLeft: 'auto' }}>
              {formatDate(note.createdAt)}
            </Text>
            {note.resolvable && (
              <Tag color={note.resolved ? 'success' : 'default'} style={{ fontSize: 11 }}>
                {note.resolved ? t('Resolved') : t('Unresolved')}
              </Tag>
            )}
          </div>
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, lineHeight: 1.6 }}>
            {note.body}
          </div>
        </div>
      ))}
    </div>
  );
};

const DiffViewer: React.FC<{ content: string }> = memo(({ content }) => {
  const { token } = useToken();
  const lines = content.split('\n');

  return (
    <div
      style={{
        fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
        fontSize: 12,
        lineHeight: 1.5,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 6,
        overflow: 'auto',
        maxHeight: 400,
        margin: '4px 0',
      }}
    >
      {lines.map((line, i) => {
        let bg = 'transparent';
        let color = token.colorText;
        if (line.startsWith('+') && !line.startsWith('+++')) {
          bg = 'rgba(46, 160, 67, 0.12)';
          color = '#2ea043';
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          bg = 'rgba(248, 81, 73, 0.12)';
          color = '#f85149';
        } else if (line.startsWith('@@')) {
          bg = 'rgba(56, 139, 253, 0.08)';
          color = '#388bfd';
        } else if (line.startsWith('diff') || line.startsWith('index')) {
          color = token.colorTextSecondary;
        }
        return (
          <div
            key={i}
            style={{
              padding: '0 12px',
              background: bg,
              color,
              whiteSpace: 'pre',
              minHeight: 20,
            }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 40,
                color: token.colorTextQuaternary,
                userSelect: 'none',
                textAlign: 'right',
                marginRight: 12,
              }}
            >
              {i + 1}
            </span>
            {line}
          </div>
        );
      })}
    </div>
  );
});

/* ─── Utilities ─── */

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);

  if (diffHours < 1) return `${Math.round(diffMs / 60000)}m ago`;
  if (diffHours < 24) return `${Math.round(diffHours)}h ago`;
  if (diffHours < 168) return `${Math.round(diffHours / 24)}d ago`;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateFull(dateStr: string): string {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
