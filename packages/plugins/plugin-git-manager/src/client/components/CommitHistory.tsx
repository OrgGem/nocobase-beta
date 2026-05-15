import React, { useEffect, useState, useCallback, memo } from 'react';
import { Table, Empty, Spin, Typography, Tag, Drawer, List, Button, Space, Select, Input, theme } from 'antd';
import {
  BranchesOutlined,
  UserOutlined,
  ClockCircleOutlined,
  FileTextOutlined,
  PlusCircleOutlined,
  EditOutlined,
  DeleteOutlined,
  DiffOutlined,
} from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useGitManager } from '../context/GitManagerContext';
import { RunReviewButton } from './RunReviewButton';
import { useT } from '../locale';

const { Text } = Typography;
const { useToken } = theme;

const STATUS_COLORS: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
  A: { color: 'green', icon: <PlusCircleOutlined />, label: 'Added' },
  M: { color: 'blue', icon: <EditOutlined />, label: 'Modified' },
  D: { color: 'red', icon: <DeleteOutlined />, label: 'Deleted' },
  R: { color: 'orange', icon: <EditOutlined />, label: 'Renamed' },
};

export const CommitHistory: React.FC = () => {
  const t = useT();
  const { token } = useToken();
  const api = useAPIClient();
  const { selectedRepo, branches: branchList, currentBranch } = useGitManager();
  const [commits, setCommits] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedCommit, setSelectedCommit] = useState<any>(null);
  const [commitDetail, setCommitDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffFile, setDiffFile] = useState<string | null>(null);
  const [searchKeyword, setSearchKeyword] = useState('');

  const loadHistory = useCallback(async () => {
    if (!selectedRepo) return;
    setLoading(true);
    try {
      const { data } = await api.request({
        url: 'gitManager:log',
        params: { repositoryId: selectedRepo.id, maxCount: 100 },
      });
      const responseData = data?.data?.data || data?.data;
      setCommits(responseData?.all || []);
    } catch (error) {
      console.warn('Failed to load commit history:', error);
      setCommits([]);
    } finally {
      setLoading(false);
    }
  }, [api, selectedRepo]);

  useEffect(() => {
    if (selectedRepo?.status === 'connected') {
      loadHistory();
    } else {
      setCommits([]);
    }
  }, [selectedRepo]);

  const filteredCommits = commits.filter((commit) => {
    const keyword = searchKeyword.trim().toLowerCase();
    if (!keyword) return true;
    return String(commit.message || commit.subject || commit.body || '').toLowerCase().includes(keyword);
  });

  const openCommitDetail = async (commit: any) => {
    setSelectedCommit(commit);
    setDetailLoading(true);
    setDiffContent(null);
    setDiffFile(null);
    try {
      const { data } = await api.request({
        url: 'gitManager:commitDetail',
        params: { repositoryId: selectedRepo.id, commitHash: commit.hash },
      });
      const responseData = data?.data?.data || data?.data;
      setCommitDetail(responseData);
    } catch {
      setCommitDetail(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const loadFileDiff = async (commitHash: string, file: string) => {
    setDiffFile(file);
    try {
      const { data } = await api.request({
        url: 'gitManager:diff',
        params: { repositoryId: selectedRepo.id, commitHash, file },
      });
      const responseData = data?.data?.data || data?.data;
      setDiffContent(responseData || '');
    } catch {
      setDiffContent('// Failed to load diff');
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
      key: 'graph',
      width: 40,
      render: (_: any, __: any, index: number) => (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%' }}>
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: index === 0 ? token.colorPrimary : token.colorBorder,
              border: `2px solid ${index === 0 ? token.colorPrimary : token.colorBorder}`,
              zIndex: 1,
            }}
          />
        </div>
      ),
    },
    {
      title: t('Message'),
      dataIndex: 'message',
      key: 'message',
      render: (text: string, record: any) => (
        <div>
          <Text strong style={{ fontSize: 13 }}>{text}</Text>
          <div style={{ marginTop: 2 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              <UserOutlined style={{ marginRight: 4 }} />
              {record.author_name}
              <span style={{ margin: '0 8px' }}>·</span>
              <ClockCircleOutlined style={{ marginRight: 4 }} />
              {formatDate(record.date)}
            </Text>
          </div>
        </div>
      ),
    },
    {
      title: 'Hash',
      dataIndex: 'hash',
      key: 'hash',
      width: 100,
      render: (hash: string) => (
        <Text code copyable style={{ fontSize: 12 }}>
          {hash?.substring(0, 7)}
        </Text>
      ),
    },
    {
      title: '',
      key: 'action',
      width: 80,
      render: (_: any, record: any) => (
        <Button size="small" icon={<DiffOutlined />} onClick={() => openCommitDetail(record)}>
          Detail
        </Button>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
        <BranchesOutlined />
        <Select
          size="small"
          style={{ width: 200 }}
          value={currentBranch}
          options={branchList.map((b) => ({ label: b, value: b }))}
          disabled
        />
        <Input.Search
          allowClear
          size="small"
          style={{ width: 280 }}
          placeholder={t('Search commit title or message')}
          value={searchKeyword}
          onChange={(event) => setSearchKeyword(event.target.value)}
        />
        <Text type="secondary">{filteredCommits.length} commits</Text>
      </div>

      {loading ? (
        <Spin />
      ) : (
        <Table
          dataSource={filteredCommits}
          columns={columns}
          rowKey="hash"
          size="small"
          pagination={{ pageSize: 30, showSizeChanger: true }}
          onRow={(record) => ({ style: { cursor: 'pointer' }, onClick: () => openCommitDetail(record) })}
        />
      )}

      <Drawer
        title={
          selectedCommit ? (
            <div>
              <Text strong>{selectedCommit.message}</Text>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {selectedCommit.hash?.substring(0, 7)} · {selectedCommit.author_name} · {formatDate(selectedCommit.date)}
                </Text>
              </div>
            </div>
          ) : 'Commit Detail'
        }
        open={!!selectedCommit}
        onClose={() => {
          setSelectedCommit(null);
          setCommitDetail(null);
          setDiffContent(null);
          setDiffFile(null);
        }}
        width={800}
        extra={
          selectedCommit && selectedRepo ? (
            <RunReviewButton
              target={{
                type: 'commit',
                repositoryId: selectedRepo.id,
                commitSha: selectedCommit.hash,
                title: selectedCommit.message,
              }}
              size="small"
            />
          ) : null
        }
      >
        {detailLoading ? (
          <Spin />
        ) : commitDetail ? (
          <div>
            <Text strong>Changed Files ({commitDetail.files?.length || 0})</Text>
            <List
              size="small"
              style={{ marginTop: 8 }}
              dataSource={commitDetail.files || []}
              renderItem={(item: any) => {
                const info = STATUS_COLORS[item.status] || STATUS_COLORS.M;
                const isActive = diffFile === item.file;
                return (
                  <List.Item
                    style={{
                      cursor: 'pointer',
                      background: isActive ? token.colorPrimaryBg : undefined,
                      padding: '6px 12px',
                      borderRadius: 4,
                    }}
                    onClick={() => loadFileDiff(selectedCommit.hash, item.file)}
                  >
                    <Space>
                      <Tag color={info.color} style={{ minWidth: 70, textAlign: 'center' }}>
                        {info.icon} {info.label}
                      </Tag>
                      <Text style={{ fontSize: 13 }}>{item.file}</Text>
                    </Space>
                  </List.Item>
                );
              }}
            />

            {diffContent !== null && (
              <div style={{ marginTop: 16 }}>
                <Text strong style={{ display: 'block', marginBottom: 8 }}>
                  <FileTextOutlined /> {diffFile}
                </Text>
                <DiffViewer content={diffContent} />
              </div>
            )}
          </div>
        ) : null}
      </Drawer>
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
        maxHeight: 500,
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
            <span style={{ display: 'inline-block', width: 40, color: token.colorTextQuaternary, userSelect: 'none', textAlign: 'right', marginRight: 12 }}>
              {i + 1}
            </span>
            {line}
          </div>
        );
      })}
    </div>
  );
});

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
