import React from 'react';
import { Tabs, Select, Space, Typography, TreeSelect, Badge } from 'antd';
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

// ─── Instance + Folder Selector (Header Bar) ────────────────────────

const HeaderBar: React.FC = () => {
  const { instanceId, setInstanceId, instances, loading, folderId, setFolder, folders } =
    useCurrentInstance();
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
            onChange={(val: number) => {
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

  const items = [
    { key: 'overview', label: t('Overview'), children: <OverviewDashboard /> },
    { key: 'jobs', label: t('Jobs'), children: <JobManager /> },
    { key: 'logs', label: t('Robot Logs'), children: <LogExplorer /> },
    { key: 'queues', label: t('Queues'), children: <QueueManager /> },
    { key: 'processes', label: t('Processes'), children: <ProcessManager /> },
    { key: 'assets', label: t('Assets'), children: <AssetManager /> },
    { key: 'robots', label: t('Robots & Sessions'), children: <RobotSessionPanel /> },
    { key: 'folders', label: t('Users & Folders'), children: <FolderUserPanel /> },
    { key: 'alerts', label: t('Alerts'), children: <AlertManager /> },
    { key: 'instances', label: t('Instances'), children: <InstanceManager /> },
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
