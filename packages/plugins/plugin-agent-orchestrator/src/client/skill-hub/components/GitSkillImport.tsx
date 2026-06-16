import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Modal,
  Steps,
  Select,
  Button,
  Table,
  Tag,
  Space,
  Typography,
  Empty,
  Spin,
  Input,
  Switch,
  Alert,
  message,
  Result,
  theme,
} from 'antd';
import {
  BranchesOutlined,
  FolderOutlined,
  CheckCircleOutlined,
  SyncOutlined,
  DatabaseOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useT } from '../locale';

const { Text } = Typography;
const { useToken } = theme;

interface GitSkillImportProps {
  open: boolean;
  onClose: (synced?: boolean) => void;
}

export const GitSkillImport: React.FC<GitSkillImportProps> = ({ open, onClose }) => {
  const t = useT();
  const { token } = useToken();
  const api = useAPIClient();

  const [step, setStep] = useState(0);

  // Step 0: Select repository
  const [repos, setRepos] = useState<any[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [selectedRepoId, setSelectedRepoId] = useState<number | null>(null);

  // Step 1: Browse & select root folder
  const [branches, setBranches] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState('');
  const [selectedRef, setSelectedRef] = useState('HEAD');
  const [folders, setFolders] = useState<any[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [currentTreePath, setCurrentTreePath] = useState('');
  const [selectedRootFolder, setSelectedRootFolder] = useState<string | null>(null);

  // Step 2: Select skills to sync
  const [skills, setSkills] = useState<any[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [importPrefix, setImportPrefix] = useState('');
  const [skillsConfigInfo, setSkillsConfigInfo] = useState<any>(null);
  const [searchText, setSearchText] = useState('');

  // Step 3: Sync results
  const [syncResults, setSyncResults] = useState<any[] | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Load repositories
  const loadRepos = useCallback(async () => {
    setReposLoading(true);
    try {
      const { data } = await api.request({ url: 'gitRepositories:list', params: { pageSize: 100 } });
      const responseData = data?.data?.data || data?.data || [];
      setRepos(responseData.filter((r: any) => r.status === 'connected'));
    } finally {
      setReposLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (open) {
      loadRepos();
      // Reset state
      setStep(0);
      setSelectedRepoId(null);
      setSelectedRootFolder(null);
      setSkills([]);
      setSelectedSkills([]);
      setSkillsConfigInfo(null);
      setSyncResults(null);
      setOverwrite(false);
      setCurrentTreePath('');
      setImportPrefix('');
      setSearchText('');
    }
  }, [open, loadRepos]);

  // Load branches when repo selected
  useEffect(() => {
    if (!selectedRepoId) return;
    api
      .request({ url: 'gitManager:branches', params: { repositoryId: selectedRepoId } })
      .then(({ data }) => {
        const responseData = data?.data?.data || data?.data;
        setBranches(responseData?.all || []);
        const cur = responseData?.current || 'main';
        setCurrentBranch(cur);
        setSelectedRef(cur);
      })
      .catch(() => setBranches([]));
  }, [selectedRepoId, api]);

  // Load root folders when ref changes
  const loadFolders = useCallback(async () => {
    if (!selectedRepoId) return;
    setFoldersLoading(true);
    try {
      const { data } = await api.request({
        url: 'gitManager:fileTree',
        params: { repositoryId: selectedRepoId, ref: selectedRef, treePath: currentTreePath },
      });
      // Only show directories
      const responseData = data?.data?.data || data?.data || [];
      setFolders(responseData.filter((f: any) => f.type === 'tree'));
    } finally {
      setFoldersLoading(false);
    }
  }, [api, selectedRepoId, selectedRef, currentTreePath]);

  useEffect(() => {
    if (step === 1 && selectedRepoId) {
      loadFolders();
    }
  }, [step, selectedRepoId, selectedRef, currentTreePath, loadFolders]);

  // Load skills from selected folder (without prefix â€” prefix is applied only on sync)
  const loadSkills = useCallback(async () => {
    if (!selectedRepoId || selectedRootFolder === null) return;
    setSkillsLoading(true);
    try {
      const { data } = await api.request({
        url: 'skillHub:gitListSkills',
        params: {
          repositoryId: selectedRepoId,
          ref: selectedRef,
          rootFolder: selectedRootFolder,
        },
      });
      const list = data?.data?.data || data?.data || [];
      setSkillsConfigInfo(data?.data?.config || data?.config || null);
      setSkills(list);
      // Pre-select all non-existing skills
      setSelectedSkills(list.filter((s: any) => !s.existsInDb).map((s: any) => s.folder));
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || t('Failed to read skills from git'));
      setSkillsConfigInfo(null);
      setSkills([]);
    } finally {
      setSkillsLoading(false);
    }
  }, [api, selectedRepoId, selectedRef, selectedRootFolder, t]);

  // Load skills only when entering step 2
  useEffect(() => {
    if (step === 2 && selectedRootFolder !== null) {
      loadSkills();
    }
  }, [step, selectedRootFolder, loadSkills]);

  // Filter skills by search text (title and description)
  const filteredSkills = useMemo(() => {
    if (!searchText.trim()) return skills;
    const lower = searchText.toLowerCase();
    return skills.filter(
      (s) =>
        (s.title || s.name || '').toLowerCase().includes(lower) || (s.description || '').toLowerCase().includes(lower),
    );
  }, [skills, searchText]);

  // Sync skills
  const handleSync = async () => {
    if (selectedSkills.length === 0) {
      message.warning(t('Please select at least one skill'));
      return;
    }
    setSyncing(true);
    try {
      const { data } = await api.request({
        url: 'skillHub:gitSyncSkills',
        method: 'POST',
        params: {
          repositoryId: selectedRepoId,
          ref: selectedRef,
          rootFolder: selectedRootFolder,
          prefix: importPrefix,
        },
        data: { skills: selectedSkills, overwrite },
      });
      setSyncResults(data?.data?.data || data?.data || []);
      setStep(3);
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || t('Sync failed'));
    } finally {
      setSyncing(false);
    }
  };

  const canNext = () => {
    if (step === 0) return !!selectedRepoId;
    if (step === 1) return selectedRootFolder !== null;
    if (step === 2) return selectedSkills.length > 0;
    return false;
  };

  const skillColumns = [
    {
      title: t('Skill'),
      key: 'name',
      render: (_: any, record: any) => (
        <div>
          <Text strong>{record.title || record.name}</Text>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {record.name}
            </Text>
          </div>
        </div>
      ),
    },
    {
      title: t('Language'),
      dataIndex: 'language',
      key: 'language',
      width: 100,
      render: (lang: string) => <Tag color={lang === 'python' ? 'blue' : 'green'}>{lang}</Tag>,
    },
    {
      title: t('Source'),
      dataIndex: 'storageType',
      key: 'storageType',
      width: 100,
      render: (storageType: string) => (
        <Tag color={storageType === 'plugin' ? 'purple' : 'cyan'}>{(storageType || 'git').toUpperCase()}</Tag>
      ),
    },
    {
      title: t('Description'),
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
    },
    {
      title: t('Status'),
      key: 'status',
      width: 120,
      render: (_: any, record: any) =>
        record.existsInDb ? <Tag color="orange">{t('Exists')}</Tag> : <Tag color="green">{t('New')}</Tag>,
    },
  ];

  // Result columns â€” show name with prefix applied
  const resultColumns = [
    {
      title: t('Skill'),
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => {
        const prefix = importPrefix ? importPrefix.trim() : '';
        const displayName = prefix ? `${prefix}${name}` : name;
        return (
          <div>
            <Text strong>{displayName}</Text>
            {prefix && (
              <div>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {t('Original')}: {name}
                </Text>
              </div>
            )}
          </div>
        );
      },
    },
    {
      title: t('Result'),
      key: 'status',
      render: (_: any, record: any) => {
        const colorMap: Record<string, string> = { created: 'green', updated: 'blue', skipped: 'orange', error: 'red' };
        return (
          <Space>
            <Tag color={colorMap[record.status] || 'default'}>{record.status}</Tag>
            {record.reason && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {record.reason}
              </Text>
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <Modal
      open={open}
      title={
        <Space>
          <BranchesOutlined />
          {t('Import Skills from Git')}
        </Space>
      }
      onCancel={() => onClose()}
      width={800}
      footer={
        step === 3 ? (
          <Button type="primary" onClick={() => onClose(true)}>
            {t('Done')}
          </Button>
        ) : (
          <Space>
            {step > 0 && step < 3 && <Button onClick={() => setStep(step - 1)}>{t('Back')}</Button>}
            {step < 2 && (
              <Button type="primary" disabled={!canNext()} onClick={() => setStep(step + 1)}>
                {t('Next')}
              </Button>
            )}
            {step === 2 && (
              <Button type="primary" loading={syncing} disabled={selectedSkills.length === 0} onClick={handleSync}>
                <SyncOutlined /> {t('Sync Selected')} ({selectedSkills.length})
              </Button>
            )}
          </Space>
        )
      }
      destroyOnClose
    >
      <Steps
        current={step}
        size="small"
        style={{ marginBottom: 24 }}
        items={[
          { title: t('Repository') },
          { title: t('Root Folder') },
          { title: t('Select Skills') },
          { title: t('Result') },
        ]}
      />

      {/* Step 0: Select Repository */}
      {step === 0 && (
        <div>
          {reposLoading ? (
            <Spin />
          ) : repos.length === 0 ? (
            <Empty description={t('No connected repositories. Please configure one in Git Manager first.')} />
          ) : (
            <div>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>
                <DatabaseOutlined /> {t('Select a connected git repository')}
              </Text>
              <Select
                style={{ width: '100%' }}
                placeholder={t('Select repository')}
                value={selectedRepoId}
                onChange={setSelectedRepoId}
                options={repos.map((r) => ({
                  label: (
                    <Space>
                      {r.name}
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {r.repoUrl}
                      </Text>
                    </Space>
                  ),
                  value: r.id,
                }))}
              />
            </div>
          )}
        </div>
      )}

      {/* Step 1: Select Root Folder */}
      {step === 1 && (
        <div>
          <div style={{ marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
            <BranchesOutlined />
            <Select
              size="small"
              style={{ width: 200 }}
              value={selectedRef}
              onChange={(val) => {
                setSelectedRef(val);
                setSelectedRootFolder(null);
              }}
              options={branches.map((b) => ({ label: b, value: b }))}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <Text strong>
              <FolderOutlined /> {t('Current Path')}: {currentTreePath || '/ (Root)'}
            </Text>
            <Button type="primary" onClick={() => setSelectedRootFolder(currentTreePath)}>
              {t('Use Current Folder')}
            </Button>
          </div>

          {foldersLoading ? (
            <Spin />
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {currentTreePath && (
                <Button
                  icon={<FolderOutlined />}
                  onClick={() => {
                    const parts = currentTreePath.split('/');
                    parts.pop();
                    setCurrentTreePath(parts.join('/'));
                  }}
                >
                  ..
                </Button>
              )}
              {folders.map((f) => (
                <Button
                  key={f.path}
                  icon={<FolderOutlined />}
                  onClick={() => setCurrentTreePath(f.path)}
                  style={{ height: 'auto', padding: '8px 16px' }}
                >
                  {f.name}
                </Button>
              ))}
              {folders.length === 0 && !currentTreePath && <Empty description={t('No folders found')} />}
            </div>
          )}

          {selectedRootFolder !== null && (
            <Alert
              style={{ marginTop: 12 }}
              type="success"
              message={`${t('Selected Root Folder')}: ${selectedRootFolder || '/'}`}
              showIcon
            />
          )}
        </div>
      )}

      {/* Step 2: Select Skills */}
      {step === 2 && (
        <div>
          {skillsConfigInfo?.initializedSkillsJson && (
            <Alert
              style={{ marginBottom: 12 }}
              type="info"
              showIcon
              message={`${t('Initialized skills.json')}: ${skillsConfigInfo.path || 'skills.json'}`}
            />
          )}
          {skillsLoading ? (
            <Spin />
          ) : skills.length === 0 ? (
            <Empty description={t('No skills found')} />
          ) : (
            <div>
              {/* Toolbar: Search + Options */}
              <div
                style={{
                  marginBottom: 12,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <Input
                  placeholder={t('Search by title or description...')}
                  prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  allowClear
                  style={{ width: 260 }}
                />
                <Space>
                  <Input
                    size="small"
                    placeholder={t('Skill Name Prefix')}
                    value={importPrefix}
                    onChange={(e) => setImportPrefix(e.target.value)}
                    style={{ width: 150 }}
                  />
                  <Text style={{ fontSize: 12, marginLeft: 8 }}>{t('Overwrite')}</Text>
                  <Switch size="small" checked={overwrite} onChange={setOverwrite} />
                </Space>
              </div>

              <div style={{ marginBottom: 8 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {filteredSkills.length} / {skills.length} {t('skills found')}
                  {importPrefix && (
                    <span style={{ marginLeft: 8 }}>
                      â€¢ {t('Prefix')}: <Tag style={{ margin: 0 }}>{importPrefix}</Tag>{' '}
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        ({t('applied on sync')})
                      </Text>
                    </span>
                  )}
                </Text>
              </div>

              <Table
                dataSource={filteredSkills}
                columns={skillColumns}
                rowKey="folder"
                size="small"
                pagination={{
                  pageSize: 10,
                  size: 'small',
                  showSizeChanger: false,
                  showTotal: (total, range) => `${range[0]}-${range[1]} / ${total}`,
                }}
                rowSelection={{
                  selectedRowKeys: selectedSkills,
                  onChange: (keys) => setSelectedSkills(keys as string[]),
                }}
                scroll={{ x: 'max-content' }}
              />
            </div>
          )}
        </div>
      )}

      {/* Step 3: Results */}
      {step === 3 && syncResults && (
        <div>
          <Result
            status="success"
            title={t('Sync Complete')}
            subTitle={`${syncResults.filter((r) => r.status === 'created').length} ${t('created')}, ${
              syncResults.filter((r) => r.status === 'updated').length
            } ${t('updated')}, ${syncResults.filter((r) => r.status === 'skipped').length} ${t('skipped')}`}
          />
          <Table
            dataSource={syncResults}
            columns={resultColumns}
            rowKey="folder"
            size="small"
            pagination={false}
            scroll={{ x: 'max-content' }}
          />
        </div>
      )}
    </Modal>
  );
};
