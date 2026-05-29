import React from 'react';
import { Alert, Tabs, Select, Space, Typography, TreeSelect } from 'antd';
import { InstanceProvider, useCurrentInstance } from '../context/InstanceContext';
import { useT } from '../locale';

// Tab components — each is a self-contained module
import { OverviewDashboard } from './OverviewDashboard';
import { JobManager } from './JobManager';
import { LogExplorer } from './LogExplorer';
import { QueueManager } from './QueueManager';
import { ProcessManager } from './ProcessManager';
import { AssetManager } from './AssetManager';
import { RobotSessionPanel } from './RobotSessionPanel';
import { FolderUserPanel } from './FolderUserPanel';
import { AlertManager } from './AlertManager';
import { InstanceManager } from './InstanceManager';

class UiPathTabErrorBoundary extends React.Component<
  React.PropsWithChildren<{ title: string }>,
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return <Alert type="error" showIcon message={this.props.title} description={this.state.error.message} />;
    }

    return this.props.children;
  }
}

// ─── Instance + Folder Selector (Header Bar) ────────────────────────

const HeaderBar: React.FC = () => {
  const { instanceId, setInstanceId, instances, loading, folderId, setFolder, folders } = useCurrentInstance();
  const t = useT();

  return (
    <Space style={{ marginBottom: 16, flexWrap: 'wrap' }} size="middle">
      {instances.length > 1 && (
        <>
          <Typography.Text strong>{t('Instance')}:</Typography.Text>
          <Select
            value={instanceId}
            onChange={setInstanceId}
            loading={loading}
            style={{ minWidth: 220 }}
            options={instances.map((i: any) => ({
              label: `${i.name} (${i.deploymentType})`,
              value: i.id,
            }))}
          />
        </>
      )}
      {folders.length > 0 && (
        <>
          <Typography.Text strong>{t('Folder')}:</Typography.Text>
          <TreeSelect
            value={folderId}
            onChange={(val?: number) => {
              if (val == null) {
                setFolder(null, null);
                return;
              }
              const f = folders.find((f: any) => f.folderId === val);
              setFolder(val, f?.folderKey || null);
            }}
            style={{ minWidth: 200 }}
            treeData={buildFolderTree(folders)}
            placeholder={t('All Folders')}
            allowClear
            showSearch
            treeNodeFilterProp="title"
          />
        </>
      )}
    </Space>
  );
};

function buildFolderTree(folders: any[]): any[] {
  const map = new Map<number, any>();
  const roots: any[] = [];

  for (const f of folders) {
    map.set(f.folderId, {
      title: f.displayName,
      value: f.folderId,
      key: f.folderKey || String(f.folderId),
      children: [],
    });
  }

  for (const f of folders) {
    const node = map.get(f.folderId);
    if (f.parentId && map.has(f.parentId)) {
      map.get(f.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

// ─── Settings Page Content ──────────────────────────────────────────

const UiPathSettingsContent: React.FC = () => {
  const t = useT();
  const tab = (title: string, children: React.ReactNode) => (
    <UiPathTabErrorBoundary title={title}>{children}</UiPathTabErrorBoundary>
  );

  const items = [
    { key: 'overview', label: t('Overview'), children: tab(t('Overview'), <OverviewDashboard />) },
    { key: 'jobs', label: t('Jobs'), children: tab(t('Jobs'), <JobManager />) },
    { key: 'logs', label: t('Robot Logs'), children: tab(t('Robot Logs'), <LogExplorer />) },
    { key: 'queues', label: t('Queues'), children: tab(t('Queues'), <QueueManager />) },
    { key: 'processes', label: t('Processes'), children: tab(t('Processes'), <ProcessManager />) },
    { key: 'assets', label: t('Assets'), children: tab(t('Assets'), <AssetManager />) },
    { key: 'robots', label: t('Robots & Sessions'), children: tab(t('Robots & Sessions'), <RobotSessionPanel />) },
    { key: 'folders', label: t('Users & Folders'), children: tab(t('Users & Folders'), <FolderUserPanel />) },
    { key: 'alerts', label: t('Alerts'), children: tab(t('Alerts'), <AlertManager />) },
    { key: 'instances', label: t('Instances'), children: tab(t('Instances'), <InstanceManager />) },
  ];

  return (
    <div>
      <HeaderBar />
      <Tabs items={items} />
    </div>
  );
};

// ─── Root Export ─────────────────────────────────────────────────────

export const UiPathSettingsPage: React.FC = () => {
  return (
    <InstanceProvider>
      <UiPathSettingsContent />
    </InstanceProvider>
  );
};
