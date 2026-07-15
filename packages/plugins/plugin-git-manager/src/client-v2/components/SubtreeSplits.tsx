import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AutoComplete,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, EditOutlined, HistoryOutlined, PlayCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useFlowContext } from '@nocobase/flow-engine';
import { useT } from '../locale';

type SubtreePolicy = 'fastForward' | 'replace' | 'merge';

interface RepositoryItem {
  id: number;
  name: string;
}

interface SubtreeConfig {
  id: number;
  name: string;
  repositoryId: number;
  sourceBranch: string;
  sourcePrefix: string;
  targetBranch: string;
  remoteName: string;
  defaultPolicy: SubtreePolicy;
  pushAfterRun: boolean;
  enabled: boolean;
  lastStatus?: string;
  lastRunAt?: string;
}

type ConfigFormValues = Omit<SubtreeConfig, 'id' | 'lastStatus' | 'lastRunAt'>;

interface PreviewResult {
  sourceSha: string;
  splitSha: string;
  targetExists: boolean;
  targetSha: string | null;
  relationship: 'target-missing' | 'already-up-to-date' | 'fast-forward' | 'diverged';
  recommendedPolicy: SubtreePolicy;
}

interface OptionsResult {
  branches: string[];
  folders: string[];
}

interface SubtreeRun {
  id: number;
  policy: SubtreePolicy;
  executionMode: 'app';
  status: string;
  sourceSha?: string;
  splitSha?: string;
  targetBeforeSha?: string;
  targetAfterSha?: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const response = 'response' in error ? error.response : undefined;
    if (response && typeof response === 'object' && 'data' in response) {
      const data = response.data;
      if (data && typeof data === 'object' && 'errors' in data && Array.isArray(data.errors)) {
        const first = data.errors[0];
        if (first && typeof first === 'object' && 'message' in first && typeof first.message === 'string') {
          return first.message;
        }
      }
    }
    if ('message' in error && typeof error.message === 'string') return error.message;
  }
  return String(error);
}

export default function SubtreeSplits() {
  const ctx = useFlowContext();
  const t = useT();
  const [form] = Form.useForm<ConfigFormValues>();
  const [configs, setConfigs] = useState<SubtreeConfig[]>([]);
  const [repositories, setRepositories] = useState<RepositoryItem[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [editing, setEditing] = useState<SubtreeConfig | null>(null);
  const [runningConfig, setRunningConfig] = useState<SubtreeConfig | null>(null);
  const [policy, setPolicy] = useState<SubtreePolicy>('fastForward');
  const [pushAfterRun, setPushAfterRun] = useState(true);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [running, setRunning] = useState(false);
  const [replaceConfirmation, setReplaceConfirmation] = useState('');
  const [historyConfig, setHistoryConfig] = useState<SubtreeConfig | null>(null);
  const [historyRuns, setHistoryRuns] = useState<SubtreeRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const repositoryName = useMemo(
    () => new Map(repositories.map((repository) => [repository.id, repository.name])),
    [repositories],
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [configResponse, repositoryResponse] = await Promise.all([
        ctx.api.request({ url: 'gitSubtreeConfigs:list', params: { pageSize: 200, sort: ['name'] } }),
        ctx.api.request({ url: 'gitRepositories:list', params: { pageSize: 200, sort: ['name'] } }),
      ]);
      setConfigs((configResponse.data?.data || []) as SubtreeConfig[]);
      setRepositories((repositoryResponse.data?.data || []) as RepositoryItem[]);
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [ctx.api]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const loadOptions = async (repositoryId: number, sourceBranch?: string, remoteName = 'origin') => {
    const response = await ctx.api.request({
      url: 'gitManager:subtreeOptions',
      params: { repositoryId, sourceBranch, remoteName },
    });
    const data = response.data?.data as OptionsResult;
    setBranches(data?.branches || []);
    setFolders(data?.folders || []);
  };

  const openCreate = () => {
    setEditing(null);
    setBranches([]);
    setFolders([]);
    form.resetFields();
    form.setFieldsValue({ remoteName: 'origin', defaultPolicy: 'fastForward', pushAfterRun: true, enabled: true });
    setConfigOpen(true);
  };

  const openEdit = async (config: SubtreeConfig) => {
    setEditing(config);
    form.setFieldsValue(config);
    setConfigOpen(true);
    try {
      await loadOptions(config.repositoryId, config.sourceBranch, config.remoteName);
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  const saveConfig = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await ctx.api.request({
        url: editing ? 'gitSubtreeConfigs:update' : 'gitSubtreeConfigs:create',
        method: 'post',
        params: editing ? { filterByTk: editing.id } : undefined,
        data: values,
      });
      message.success(t(editing ? 'Subtree configuration updated' : 'Subtree configuration created'));
      setConfigOpen(false);
      await loadData();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const deleteConfig = async (id: number) => {
    try {
      await ctx.api.request({ url: 'gitSubtreeConfigs:destroy', method: 'post', params: { filterByTk: id } });
      message.success(t('Deleted'));
      await loadData();
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  const openRun = (config: SubtreeConfig) => {
    setRunningConfig(config);
    setPolicy(config.defaultPolicy || 'fastForward');
    setPushAfterRun(config.pushAfterRun !== false);
    setPreview(null);
    setReplaceConfirmation('');
  };

  const openHistory = async (config: SubtreeConfig) => {
    setHistoryConfig(config);
    setHistoryLoading(true);
    try {
      const response = await ctx.api.request({
        url: 'gitSubtreeRuns:list',
        params: { filter: { configId: config.id }, pageSize: 100, sort: ['-startedAt'] },
      });
      setHistoryRuns((response.data?.data || []) as SubtreeRun[]);
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setHistoryLoading(false);
    }
  };

  const previewRun = async () => {
    if (!runningConfig) return;
    setPreviewing(true);
    try {
      const response = await ctx.api.request({
        url: 'gitManager:subtreePreview',
        method: 'post',
        data: { configId: runningConfig.id },
      });
      const data = response.data?.data as PreviewResult;
      setPreview(data);
      setPolicy(data.recommendedPolicy);
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setPreviewing(false);
    }
  };

  const runSubtree = async () => {
    if (!runningConfig || !preview) return;
    if (policy === 'replace' && replaceConfirmation !== runningConfig.targetBranch) return;
    setRunning(true);
    try {
      await ctx.api.request({
        url: policy === 'replace' ? 'gitManager:subtreeReplace' : 'gitManager:subtreeRun',
        method: 'post',
        data: {
          configId: runningConfig.id,
          policy,
          push: pushAfterRun,
          expectedTargetSha: preview.targetSha,
        },
      });
      message.success(t('Subtree split completed'));
      setRunningConfig(null);
      await loadData();
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setRunning(false);
    }
  };

  const columns = [
    { title: t('Name'), dataIndex: 'name', key: 'name' },
    {
      title: t('Repository'),
      dataIndex: 'repositoryId',
      key: 'repositoryId',
      render: (repositoryId: number) => repositoryName.get(repositoryId) || repositoryId,
    },
    {
      title: t('Source'),
      key: 'source',
      render: (_: unknown, config: SubtreeConfig) => `${config.sourceBranch}:${config.sourcePrefix}`,
    },
    { title: t('Target branch'), dataIndex: 'targetBranch', key: 'targetBranch' },
    {
      title: t('Last status'),
      dataIndex: 'lastStatus',
      key: 'lastStatus',
      render: (status?: string) =>
        status ? (
          <Tag color={status === 'success' ? 'green' : status === 'conflict' ? 'orange' : 'red'}>{status}</Tag>
        ) : (
          '—'
        ),
    },
    {
      title: t('Actions'),
      key: 'actions',
      render: (_: unknown, config: SubtreeConfig) => (
        <Space>
          <Button icon={<PlayCircleOutlined />} size="small" disabled={!config.enabled} onClick={() => openRun(config)}>
            {t('Run')}
          </Button>
          <Button icon={<EditOutlined />} size="small" onClick={() => openEdit(config)} aria-label={t('Edit')} />
          <Button
            icon={<HistoryOutlined />}
            size="small"
            onClick={() => openHistory(config)}
            aria-label={t('Run history')}
          />
          <Popconfirm title={t('Delete this subtree configuration?')} onConfirm={() => deleteConfig(config.id)}>
            <Button icon={<DeleteOutlined />} size="small" danger aria-label={t('Delete')} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={t('Subtree Splits')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('Add subtree configuration')}
        </Button>
      }
    >
      <Table rowKey="id" dataSource={configs} columns={columns} loading={loading} pagination={{ pageSize: 20 }} />

      <Modal
        title={editing ? t('Edit subtree configuration') : t('Add subtree configuration')}
        open={configOpen}
        onCancel={() => setConfigOpen(false)}
        onOk={saveConfig}
        confirmLoading={saving}
        width={680}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('Name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="repositoryId" label={t('Repository')} rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={repositories.map((repository) => ({ value: repository.id, label: repository.name }))}
              onChange={async (repositoryId: number) => {
                form.setFieldsValue({ sourceBranch: undefined, sourcePrefix: undefined });
                setFolders([]);
                try {
                  await loadOptions(repositoryId, undefined, form.getFieldValue('remoteName'));
                } catch (error) {
                  message.error(errorMessage(error));
                }
              }}
            />
          </Form.Item>
          <Form.Item name="remoteName" label={t('Remote name')} rules={[{ required: true }]}>
            <Input placeholder="origin" />
          </Form.Item>
          <Form.Item name="sourceBranch" label={t('Source branch')} rules={[{ required: true }]}>
            <Select
              showSearch
              options={branches.map((branch) => ({ value: branch, label: branch }))}
              onChange={async (sourceBranch: string) => {
                form.setFieldValue('sourcePrefix', undefined);
                const repositoryId = form.getFieldValue('repositoryId');
                if (!repositoryId) return;
                try {
                  await loadOptions(repositoryId, sourceBranch, form.getFieldValue('remoteName'));
                } catch (error) {
                  message.error(errorMessage(error));
                }
              }}
            />
          </Form.Item>
          <Form.Item name="sourcePrefix" label={t('Source folder')} rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={folders.map((folder) => ({ value: folder, label: folder }))}
            />
          </Form.Item>
          <Form.Item name="targetBranch" label={t('Target branch')} rules={[{ required: true }]}>
            <AutoComplete options={branches.map((branch) => ({ value: branch }))} />
          </Form.Item>
          <Form.Item name="defaultPolicy" label={t('Default policy')} rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'fastForward', label: t('Fast-forward only') },
                { value: 'replace', label: t('Replace target') },
                { value: 'merge', label: t('Merge histories') },
              ]}
            />
          </Form.Item>
          <Form.Item name="pushAfterRun" label={t('Push after run')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="enabled" label={t('Enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t('Run subtree split')}
        open={!!runningConfig}
        onCancel={() => setRunningConfig(null)}
        onOk={runSubtree}
        okText={t('Run')}
        okButtonProps={{
          disabled: !preview || (policy === 'replace' && replaceConfirmation !== runningConfig?.targetBranch),
        }}
        confirmLoading={running}
        width={720}
      >
        {runningConfig && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions size="small" bordered column={1}>
              <Descriptions.Item label={t('Source')}>
                {runningConfig.sourceBranch}:{runningConfig.sourcePrefix}
              </Descriptions.Item>
              <Descriptions.Item label={t('Target branch')}>{runningConfig.targetBranch}</Descriptions.Item>
            </Descriptions>
            <Button onClick={previewRun} loading={previewing}>
              {t('Preview')}
            </Button>
            {preview && (
              <Alert
                type={preview.relationship === 'diverged' ? 'warning' : 'info'}
                showIcon
                message={t(`Subtree relationship: ${preview.relationship}`)}
                description={`${preview.targetSha || t('Target branch does not exist')} → ${preview.splitSha}`}
              />
            )}
            <Radio.Group value={policy} onChange={(event) => setPolicy(event.target.value as SubtreePolicy)}>
              <Space direction="vertical">
                <Radio value="fastForward">{t('Fast-forward only')}</Radio>
                <Radio value="replace">{t('Replace target')}</Radio>
                <Radio value="merge">{t('Merge histories')}</Radio>
              </Space>
            </Radio.Group>
            {policy === 'replace' && (
              <Alert
                type="error"
                showIcon
                message={t('Replace target may discard target-only commits')}
                description={
                  <Space direction="vertical" style={{ width: '100%' }}>
                    <Typography.Text>{t('Type the target branch name to confirm')}</Typography.Text>
                    <Input
                      value={replaceConfirmation}
                      onChange={(event) => setReplaceConfirmation(event.target.value)}
                    />
                  </Space>
                }
              />
            )}
            <Space>
              <Switch checked={pushAfterRun} onChange={setPushAfterRun} />
              <Typography.Text>{t('Push target branch after success')}</Typography.Text>
            </Space>
          </Space>
        )}
      </Modal>

      <Modal
        title={`${t('Run history')}: ${historyConfig?.name || ''}`}
        open={!!historyConfig}
        onCancel={() => setHistoryConfig(null)}
        footer={null}
        width={1000}
      >
        <Table
          rowKey="id"
          loading={historyLoading}
          dataSource={historyRuns}
          pagination={{ pageSize: 10 }}
          columns={[
            {
              title: t('Started at'),
              dataIndex: 'startedAt',
              render: (value: string) => new Date(value).toLocaleString(),
            },
            { title: t('Policy'), dataIndex: 'policy' },
            { title: t('Execution mode'), dataIndex: 'executionMode', render: () => t('App process') },
            {
              title: t('Status'),
              dataIndex: 'status',
              render: (value: string) => (
                <Tag color={value === 'success' ? 'green' : value === 'conflict' ? 'orange' : 'red'}>{value}</Tag>
              ),
            },
            { title: t('Split SHA'), dataIndex: 'splitSha', ellipsis: true },
            { title: t('Target before'), dataIndex: 'targetBeforeSha', ellipsis: true },
            { title: t('Target after'), dataIndex: 'targetAfterSha', ellipsis: true },
            { title: t('Error'), dataIndex: 'error', ellipsis: true },
          ]}
        />
      </Modal>
    </Card>
  );
}
