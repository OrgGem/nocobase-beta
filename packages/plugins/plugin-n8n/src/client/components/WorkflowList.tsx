import React, { useState, useMemo } from 'react';
import { Table, Switch, Input, Tag, Button, Drawer, message, Space, Tree, Select, Empty, Spin, Badge } from 'antd';
import {
  ReloadOutlined,
  EyeOutlined,
  FolderOutlined,
  TagOutlined,
  AppstoreOutlined,
  ProjectOutlined,
  SearchOutlined,
  PartitionOutlined,
  FileTextOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { WorkflowCanvas } from './WorkflowCanvas';
import { useAPIClient } from '@nocobase/client';
import { useN8nRequest } from '../hooks/useN8nRequest';
import { useCurrentInstance } from '../context/InstanceContext';
import { useT } from '../locale';

interface ProjectItem {
  id: string;
  name: string;
}

interface TagItem {
  id: string;
  name: string;
}

interface WorkflowItem {
  id: string;
  name: string;
  active: boolean;
  tags?: TagItem[];
  projectId?: string;
  projectName?: string;
  createdAt?: string;
  updatedAt?: string;
  data?: any;
  nodes?: any[];
  activeVersion?: any;
}

type TreeFilter = { type: 'all' } | { type: 'project'; id: string } | { type: 'tag'; id: string };

export const WorkflowList: React.FC = () => {
  const t = useT();
  const api = useAPIClient();
  const { instanceId } = useCurrentInstance();

  const [search, setSearch] = useState('');
  const [treeFilter, setTreeFilter] = useState<TreeFilter>({ type: 'all' });
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [detailView, setDetailView] = useState<'canvas' | 'json'>('canvas');

  const { data: wfData, loading: wfLoading, refresh: refreshWf } = useN8nRequest('n8nWorkflows', 'list');
  const { data: projectsData, loading: projLoading } = useN8nRequest('n8nProjects', 'list');
  const { data: tagsData, loading: tagsLoading } = useN8nRequest('n8nTags', 'list');

  const workflows: WorkflowItem[] = useMemo(() => wfData?.data || wfData || [], [wfData]);
  const projects: ProjectItem[] = useMemo(() => projectsData?.data || projectsData || [], [projectsData]);
  const tags: TagItem[] = useMemo(() => tagsData?.data || tagsData || [], [tagsData]);

  // Build project name lookup
  const projectMap = useMemo(() => {
    const map = new Map<string, string>();
    projects.forEach((p) => map.set(p.id, p.name));
    return map;
  }, [projects]);

  // Count workflows per project & tag
  const projectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    workflows.forEach((w) => {
      const pid = w.projectId || '_unassigned';
      counts.set(pid, (counts.get(pid) || 0) + 1);
    });
    return counts;
  }, [workflows]);

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    workflows.forEach((w) => {
      w.tags?.forEach((tag) => {
        counts.set(tag.id || tag.name, (counts.get(tag.id || tag.name) || 0) + 1);
      });
    });
    return counts;
  }, [workflows]);

  // Filter workflows by tree selection + search
  const filteredWorkflows = useMemo(() => {
    let filtered = workflows;

    if (treeFilter.type === 'project') {
      filtered = filtered.filter((w) => w.projectId === treeFilter.id);
    } else if (treeFilter.type === 'tag') {
      filtered = filtered.filter((w) => w.tags?.some((tag) => (tag.id || tag.name) === treeFilter.id));
    }

    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(
        (w) =>
          w.name?.toLowerCase().includes(q) ||
          w.tags?.some((tag) => tag.name?.toLowerCase().includes(q)) ||
          projectMap.get(w.projectId || '')?.toLowerCase().includes(q),
      );
    }

    return filtered;
  }, [workflows, treeFilter, search, projectMap]);

  // Build tree data
  const treeData = useMemo(() => {
    const projectChildren = projects.map((p) => ({
      key: `project:${p.id}`,
      title: (
        <span style={{ whiteSpace: 'normal', wordWrap: 'break-word', display: 'flex', alignItems: 'center', gap: 6 }}>
          {p.name} <Badge count={projectCounts.get(p.id) || 0} size="small" style={{ backgroundColor: '#1890ff', marginLeft: 'auto' }} />
        </span>
      ),
      icon: <FolderOutlined />,
    }));

    // Add unassigned if any workflows have no projectId
    const unassignedCount = projectCounts.get('_unassigned') || 0;
    if (unassignedCount > 0) {
      projectChildren.push({
        key: 'project:_unassigned',
        title: (
          <span>
            {t('Unassigned')}{' '}
            <Badge count={unassignedCount} size="small" style={{ backgroundColor: '#999' }} />
          </span>
        ),
        icon: <FolderOutlined />,
      });
    }

    const tagChildren = tags.map((tag) => ({
      key: `tag:${tag.id || tag.name}`,
      title: (
        <span style={{ whiteSpace: 'normal', wordWrap: 'break-word', display: 'flex', alignItems: 'center', gap: 6 }}>
          {tag.name}{' '}
          <Badge
            count={tagCounts.get(tag.id || tag.name) || 0}
            size="small"
            style={{ backgroundColor: '#52c41a', marginLeft: 'auto' }}
          />
        </span>
      ),
      icon: <TagOutlined />,
    }));

    return [
      {
        key: 'all',
        title: (
          <span>
            {t('All Workflows')}{' '}
            <Badge count={workflows.length} size="small" style={{ backgroundColor: '#722ed1' }} />
          </span>
        ),
        icon: <AppstoreOutlined />,
      },
      {
        key: 'projects',
        title: t('Projects'),
        icon: <ProjectOutlined />,
        children: projectChildren.length > 0 ? projectChildren : undefined,
        selectable: false,
      },
      {
        key: 'tags',
        title: t('Tags'),
        icon: <TagOutlined />,
        children: tagChildren.length > 0 ? tagChildren : undefined,
        selectable: false,
      },
    ];
  }, [projects, tags, workflows.length, projectCounts, tagCounts, t]);

  const handleTreeSelect = (selectedKeys: React.Key[]) => {
    const key = selectedKeys[0] as string;
    if (!key || key === 'all') {
      setTreeFilter({ type: 'all' });
    } else if (key.startsWith('project:')) {
      const id = key.replace('project:', '');
      setTreeFilter({ type: 'project', id });
    } else if (key.startsWith('tag:')) {
      const id = key.replace('tag:', '');
      setTreeFilter({ type: 'tag', id });
    }
  };

  const handleToggleActive = async (id: string, active: boolean) => {
    try {
      const action = active ? 'activate' : 'deactivate';
      await api.request({ url: `n8nWorkflows:${action}`, params: { instanceId, filterByTk: id } });
      message.success(t(active ? 'Activated' : 'Deactivated'));
      refreshWf();
    } catch (err: any) {
      message.error(err.message || t('Failed'));
    }
  };

  const handleViewDetail = async (id: string) => {
    const res = await api.request({ url: 'n8nWorkflows:get', params: { instanceId, filterByTk: id } });
    setDetail(res?.data);
    setDetailOpen(true);
  };

  const refresh = () => {
    refreshWf();
  };

  const selectedTreeKey = useMemo(() => {
    if (treeFilter.type === 'all') return ['all'];
    if (treeFilter.type === 'project') return [`project:${treeFilter.id}`];
    if (treeFilter.type === 'tag') return [`tag:${treeFilter.id}`];
    return ['all'];
  }, [treeFilter]);

  const columns = [
    {
      title: t('Name'),
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: WorkflowItem) => (
        <div style={{ whiteSpace: 'normal', wordWrap: 'break-word', minWidth: 150 }}>
          <span style={{ fontWeight: 500 }}>{name}</span>
          {record.projectId && projectMap.has(record.projectId) && (
            <Tag
              color="purple"
              style={{ marginLeft: 8, fontSize: 11, borderRadius: 12, border: '1px solid #d3adf7', whiteSpace: 'normal', height: 'auto', padding: '2px 8px' }}
            >
              {projectMap.get(record.projectId)}
            </Tag>
          )}
        </div>
      ),
    },
    {
      title: t('Active'),
      dataIndex: 'active',
      key: 'active',
      width: 80,
      render: (active: boolean, record: WorkflowItem) => (
        <Switch checked={active} onChange={(checked) => handleToggleActive(record.id, checked)} size="small" />
      ),
    },
    {
      title: t('Tags'),
      dataIndex: 'tags',
      key: 'tags',
      width: 200,
      render: (wfTags: TagItem[]) => (
        <Space size={[0, 4]} wrap>
          {wfTags?.map((tag) => (
            <Tag
              key={tag.id || tag.name}
              color="blue"
              style={{ cursor: 'pointer', borderRadius: 12, border: '1px solid #91d5ff', whiteSpace: 'normal', height: 'auto', padding: '2px 8px' }}
              onClick={() => setTreeFilter({ type: 'tag', id: tag.id || tag.name })}
            >
              {tag.name}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: t('Triggers / Types'),
      key: 'triggers',
      width: 250,
      render: (_: any, record: any) => {
        // Attempt to find nodes from raw data or meta
        const rawData = record.data ?? record;
        const dNodes = record.activeVersion?.nodes ?? record.nodes ?? rawData?.activeVersion?.nodes ?? rawData?.nodes ?? [];
        if (!dNodes.length) return null;
        
        const triggerNodes = dNodes.filter((n: any) => 
          n.type?.toLowerCase().includes('trigger') || n.type?.toLowerCase().includes('webhook')
        );
        
        return (
          <Space size={[4, 4]} wrap>
            {triggerNodes.map((n: any) => {
              const shortTypeName = n.type.replace(/^n8n-nodes-base\./, '').replace(/^@[^.]+\./, '');
              const isSchedule = n.type.toLowerCase().includes('schedule');
              const color = isSchedule ? '#faad14' : '#fa541c';
              return (
                <Tag key={n.id} style={{ borderColor: color, color, borderRadius: 12, backgroundColor: 'transparent', whiteSpace: 'normal', height: 'auto', padding: '2px 8px' }}>
                  <ThunderboltOutlined style={{ marginRight: 4 }} />
                  {shortTypeName}
                </Tag>
              );
            })}
          </Space>
        );
      },
    },
    {
      title: t('Updated'),
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 160,
      render: (v: string) => (v ? new Date(v).toLocaleString() : ''),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 60,
      render: (_: any, record: WorkflowItem) => (
        <Button type="link" icon={<EyeOutlined />} onClick={() => handleViewDetail(record.id)} />
      ),
    },
  ];

  const loading = wfLoading || projLoading || tagsLoading;

  return (
    <div style={{ display: 'flex', gap: 16 }}>
      {/* Sidebar Tree */}
      <div
        style={{
          width: 240,
          minWidth: 240,
          borderRight: '1px solid #f0f0f0',
          paddingRight: 16,
          overflow: 'auto',
        }}
      >
        <div style={{ marginBottom: 12, fontWeight: 600, fontSize: 14 }}>{t('Browse')}</div>
        {loading && !workflows.length ? (
          <Spin size="small" />
        ) : (
          <Tree
            treeData={treeData}
            selectedKeys={selectedTreeKey}
            onSelect={handleTreeSelect}
            defaultExpandAll
            showIcon
            blockNode
          />
        )}
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }} align="center">
          <Space>
            <Input.Search
              placeholder={t('Search workflows...')}
              onSearch={(v) => setSearch(v)}
              onChange={(e) => !e.target.value && setSearch('')}
              allowClear
              style={{ width: 300 }}
              prefix={<SearchOutlined />}
            />
            {treeFilter.type !== 'all' && (
              <Tag
                closable
                onClose={() => setTreeFilter({ type: 'all' })}
                color={treeFilter.type === 'project' ? 'purple' : 'green'}
              >
                {treeFilter.type === 'project'
                  ? `${t('Project')}: ${treeFilter.id === '_unassigned' ? t('Unassigned') : projectMap.get(treeFilter.id) || treeFilter.id}`
                  : `${t('Tag')}: ${tags.find((tg) => (tg.id || tg.name) === treeFilter.id)?.name || treeFilter.id}`}
              </Tag>
            )}
          </Space>
          <Button icon={<ReloadOutlined />} onClick={refresh}>
            {t('Refresh')}
          </Button>
        </Space>

        <Table
          columns={columns}
          dataSource={filteredWorkflows}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => `${total} workflows` }}
          size="small"
        />
      </div>

      <Drawer
        title={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{detail?.name || detail?.data?.name || t('Workflow Detail')}</span>
            <Space size={4} style={{ marginRight: 32 }}>
              <Button
                type={detailView === 'canvas' ? 'primary' : 'default'}
                size="small"
                icon={<PartitionOutlined />}
                onClick={() => setDetailView('canvas')}
              >
                {t('Flow')}
              </Button>
              <Button
                type={detailView === 'json' ? 'primary' : 'default'}
                size="small"
                icon={<FileTextOutlined />}
                onClick={() => setDetailView('json')}
              >
                JSON
              </Button>
            </Space>
          </div>
        }
        open={detailOpen}
        onClose={() => { setDetailOpen(false); setDetailView('canvas'); }}
        width={800}
        styles={{ body: { padding: detailView === 'canvas' ? 0 : 24, height: 'calc(100vh - 55px)' } }}
      >
        {detail && detailView === 'canvas' && (
          <WorkflowCanvas workflow={detail} />
        )}
        {detail && detailView === 'json' && (
          <pre style={{ fontSize: 12, overflow: 'auto', height: '100%', margin: 0 }}>
            {JSON.stringify(detail, null, 2)}
          </pre>
        )}
      </Drawer>
    </div>
  );
};
