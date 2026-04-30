import React, { useEffect } from 'react';
import { Tabs, Select, Space, Typography, Tag, theme } from 'antd';
import {
  BranchesOutlined, FolderOutlined, HistoryOutlined, ToolOutlined, DatabaseOutlined, MergeOutlined,
  RobotOutlined, AuditOutlined, ClockCircleOutlined,
} from '@ant-design/icons';
import { GitManagerProvider, useGitManager } from '../context/GitManagerContext';
import { RepositoryConfig } from './RepositoryConfig';
import { FileExplorer } from './FileExplorer';
import { CommitHistory } from './CommitHistory';
import { MergeRequests } from './MergeRequests';
import { GitOperations } from './GitOperations';
import { ReviewFlows } from './ReviewFlows';
import { ReviewHistory } from './ReviewHistory';
import { PollingStatus } from './PollingStatus';
import { useT } from '../locale';

const { Text } = Typography;
const { useToken } = theme;

const GitManagerContent: React.FC = () => {
  const t = useT();
  const { token } = useToken();
  const { repos, selectedRepo, setSelectedRepo, refreshRepos } = useGitManager();

  useEffect(() => {
    refreshRepos();
  }, []);

  return (
    <div style={{ height: '100%' }}>
      {/* Repository selector bar */}
      <div
        style={{
          padding: '12px 0',
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <DatabaseOutlined style={{ fontSize: 16 }} />
        <Text strong>Repository:</Text>
        <Select
          style={{ minWidth: 250 }}
          placeholder={t('Select a repository')}
          value={selectedRepo?.id}
          onChange={(id) => {
            const repo = repos.find((r) => r.id === id);
            setSelectedRepo(repo || null);
          }}
          options={repos.map((r) => ({
            label: (
              <Space>
                {r.name}
                <Tag
                  color={r.status === 'connected' ? 'green' : 'default'}
                  style={{ fontSize: 11 }}
                >
                  {r.status === 'connected' ? t('Connected') : t('Disconnected')}
                </Tag>
              </Space>
            ),
            value: r.id,
          }))}
          allowClear
          onClear={() => setSelectedRepo(null)}
        />
        {selectedRepo && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {selectedRepo.repoUrl}
          </Text>
        )}
      </div>

      <Tabs
        type="card"
        defaultActiveKey="repos"
        destroyInactiveTabPane
        items={[
          {
            key: 'repos',
            label: (
              <span>
                <DatabaseOutlined /> {t('Repositories')}
              </span>
            ),
            children: <RepositoryConfig />,
          },
          {
            key: 'explorer',
            label: (
              <span>
                <FolderOutlined /> {t('File Explorer')}
              </span>
            ),
            children: <FileExplorer />,
          },
          {
            key: 'history',
            label: (
              <span>
                <HistoryOutlined /> {t('History')}
              </span>
            ),
            children: <CommitHistory />,
          },
          {
            key: 'merge-requests',
            label: (
              <span>
                <MergeOutlined /> {t('Merge Requests')}
              </span>
            ),
            children: <MergeRequests />,
          },
          {
            key: 'operations',
            label: (
              <span>
                <ToolOutlined /> {t('Operations')}
              </span>
            ),
            children: <GitOperations />,
          },
          {
            key: 'review-flows',
            label: (
              <span>
                <RobotOutlined /> {t('Review Flows')}
              </span>
            ),
            children: <ReviewFlows />,
          },
          {
            key: 'review-history',
            label: (
              <span>
                <AuditOutlined /> {t('Review History')}
              </span>
            ),
            children: <ReviewHistory />,
          },
          {
            key: 'polling',
            label: (
              <span>
                <ClockCircleOutlined /> {t('Polling')}
              </span>
            ),
            children: <PollingStatus />,
          },
        ]}
      />
    </div>
  );
};

export const GitManagerSettings: React.FC = () => {
  return (
    <GitManagerProvider>
      <GitManagerContent />
    </GitManagerProvider>
  );
};
