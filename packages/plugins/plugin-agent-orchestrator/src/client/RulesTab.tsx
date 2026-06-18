import React, { useState } from 'react';
import {
  Table,
  Button,
  Drawer,
  Form,
  InputNumber,
  Switch,
  Space,
  Popconfirm,
  Card,
  message,
  Tag,
  Typography,
  Alert,
  Collapse,
  Empty,
  Select,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  SwapRightOutlined,
  WarningOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { useApp } from '@nocobase/client-v2';
import { AIEmployeeSelect } from './AIEmployeeSelect';
import { useAIEmployees } from './AIEmployeesContext';

const { Text } = Typography;

/**
 * Mirrors server-side `sanitizeToolPart` in delegate-task.ts so we can compute
 * the expected delegation tool names here and detect when the leader hasn't
 * added them to its skillSettings.tools.
 */
const sanitizeToolPart = (value: string) => (value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
const expectedDelegateToolName = (leader: string, sub: string) =>
  `delegate_${sanitizeToolPart(leader)}_to_${sanitizeToolPart(sub)}`;
const expectedDispatchToolName = (leader: string) => `dispatch_subagents_${sanitizeToolPart(leader)}`;
const controllerToolNames = [
  'orchestrator_plan_goal',
  'orchestrator_execute_plan',
  'orchestrator_status',
  'orchestrator_cancel',
];
const toolLikeNames = new Set([...controllerToolNames, 'external_rag_search', 'skill_hub_execute']);

const isToolLikeName = (name: string) =>
  toolLikeNames.has(name) ||
  name.startsWith('delegate_') ||
  name.startsWith('dispatch_subagents_') ||
  name.startsWith('skill_hub_') ||
  name.startsWith('browser_') ||
  name.startsWith('drawio-');

const normalizeToolBinding = (value: any) => {
  const name = typeof value === 'string' ? value : value?.name;
  if (typeof name !== 'string' || !name.trim()) return null;
  return {
    name: name.trim(),
    autoCall: value?.autoCall === true,
  };
};

const normalizeSkillSettingsForTools = (skillSettings: any) => {
  const source = skillSettings && typeof skillSettings === 'object' ? skillSettings : {};
  const toolsByName = new Map<string, { name: string; autoCall: boolean }>();
  const addTool = (tool: { name: string; autoCall: boolean } | null) => {
    if (!tool || toolsByName.has(tool.name)) return;
    toolsByName.set(tool.name, tool);
  };

  if (Array.isArray(source.tools)) {
    for (const item of source.tools) {
      addTool(normalizeToolBinding(item));
    }
  }

  const nextSkills: string[] = [];
  if (Array.isArray(source.skills)) {
    for (const item of source.skills) {
      if (typeof item === 'string') {
        const name = item.trim();
        if (!name) continue;
        if (isToolLikeName(name)) {
          addTool({ name, autoCall: false });
        } else {
          nextSkills.push(name);
        }
        continue;
      }
      addTool(normalizeToolBinding(item));
    }
  }

  return {
    ...source,
    skills: nextSkills,
    tools: Array.from(toolsByName.values()),
  };
};

export const RulesTab: React.FC = () => {
  const api = useApp().apiClient;
  const [visible, setVisible] = useState(false);
  const [editingRecord, setEditingRecord] = useState<any>(null);
  const [form] = Form.useForm();

  const { data, loading, refresh } = useRequest(() =>
    api.request({
      url: 'orchestratorConfig:list',
      params: {
        sort: ['-createdAt'],
      },
    }),
  );

  const { data: llmServicesData, loading: llmLoading } = useRequest(() =>
    api.request({
      url: 'ai:listAllEnabledModels',
    }),
  );

  const { data: harnessProfilesData, loading: harnessLoading } = useRequest(() =>
    api.request({
      url: 'agentHarnessProfiles:list',
      params: {
        filter: { enabled: true },
        sort: ['tag'],
        pageSize: 100,
      },
    }),
  );

  const llmServices = React.useMemo(() => {
    const raw = (llmServicesData as any)?.data ?? llmServicesData;
    if (Array.isArray(raw)) return raw;
    return Array.isArray(raw?.data) ? raw.data : [];
  }, [llmServicesData]);

  const harnessProfiles = React.useMemo(() => {
    const raw = (harnessProfilesData as any)?.data ?? harnessProfilesData;
    if (Array.isArray(raw)) return raw;
    return Array.isArray(raw?.data) ? raw.data : [];
  }, [harnessProfilesData]);

  // P3 FIX: Use shared context instead of duplicate API call
  const { employeeMap, toolNamesMap, refresh: refreshEmployees } = useAIEmployees();
  const rules = React.useMemo(() => {
    const raw = (data as any)?.data ?? data;
    if (Array.isArray(raw)) return raw;
    return Array.isArray(raw?.data) ? raw.data : [];
  }, [data]);

  const handleAddToolsToEmployee = async (employeeUsername: string, toolNames: string[]) => {
    try {
      // Re-fetch the leader to merge current tools and clean up legacy skillSettings.skills tool entries.
      const leaderResp = await api.request({
        url: 'aiEmployees:get',
        params: { filterByTk: employeeUsername },
      });
      const leader = (leaderResp as any)?.data?.data;
      if (!leader) {
        message.error('Could not load AI employee.');
        return;
      }
      const normalizedSkillSettings = normalizeSkillSettingsForTools(leader.skillSettings);
      const existingNames = new Set(normalizedSkillSettings.tools.map((tool: { name: string }) => tool.name));
      const missing = toolNames.filter((toolName) => !existingNames.has(toolName));
      const hadLegacyToolBindings =
        JSON.stringify(normalizedSkillSettings) !== JSON.stringify(leader.skillSettings || {});
      if (!missing.length && !hadLegacyToolBindings) {
        message.info('Tools already present.');
        await refreshEmployees();
        return;
      }
      const nextTools = [...normalizedSkillSettings.tools, ...missing.map((name) => ({ name, autoCall: false }))];
      await api.request({
        url: 'aiEmployees:update',
        method: 'put',
        params: { filterByTk: employeeUsername },
        data: { skillSettings: { ...normalizedSkillSettings, tools: nextTools } },
      });
      message.success(
        missing.length
          ? `Added ${missing.length} tool${missing.length > 1 ? 's' : ''} to ${employeeUsername}.`
          : `Normalized tool bindings for ${employeeUsername}.`,
      );
      await refreshEmployees();
    } catch (e: any) {
      message.error(`Auto-assign failed: ${e?.message || 'unknown error'}`);
    }
  };

  const handleAddToolToEmployee = async (employeeUsername: string, toolName: string) => {
    await handleAddToolsToEmployee(employeeUsername, [toolName]);
  };

  const handleAutoAssignTool = async (record: any) => {
    await handleAddToolToEmployee(
      record.leaderUsername,
      expectedDelegateToolName(record.leaderUsername, record.subAgentUsername),
    );
  };

  const handleAutoAssignDispatchTool = async (leaderUsername: string) => {
    await handleAddToolToEmployee(leaderUsername, expectedDispatchToolName(leaderUsername));
  };

  const subAgentLeaderCount = React.useMemo(() => {
    const counts = new Map<string, Set<string>>();
    for (const rule of rules) {
      const set = counts.get(rule.subAgentUsername) || new Set<string>();
      set.add(rule.leaderUsername);
      counts.set(rule.subAgentUsername, set);
    }
    return counts;
  }, [rules]);

  const aliasConflicts = React.useMemo(() => {
    return Array.from(subAgentLeaderCount.entries())
      .filter(([, leaders]) => leaders.size > 1)
      .map(([sub, leaders]) => ({ sub, leaders: Array.from(leaders) }));
  }, [subAgentLeaderCount]);

  const groupedRules = React.useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const rule of rules) {
      const key = rule.leaderUsername || 'unknown';
      let items = groups.get(key);
      if (!items) {
        items = [];
        groups.set(key, items);
      }
      items.push(rule);
    }

    return Array.from(groups.entries()).map(([leaderUsername, items]) => ({
      leaderUsername,
      items,
    }));
  }, [rules]);

  const handleOpen = (record?: any) => {
    setEditingRecord(record);
    if (record) {
      form.setFieldsValue(record);
    } else {
      form.resetFields();
      form.setFieldsValue({ enabled: true, maxDepth: 1, timeout: 120000, recursionLimit: 50, harnessTag: 'default' });
    }
    setVisible(true);
  };

  const handleClose = () => {
    setVisible(false);
    setEditingRecord(null);
  };

  const handleSave = async (values: any) => {
    // Validate: leader !== subAgent
    if (values.leaderUsername === values.subAgentUsername) {
      message.error('Leader and Sub-Agent cannot be the same employee.');
      return;
    }

    try {
      if (editingRecord) {
        await api.request({
          url: 'orchestratorConfig:update',
          method: 'put',
          params: { filterByTk: editingRecord.id },
          data: values,
        });
        message.success('Rule updated');
      } else {
        await api.request({
          url: 'orchestratorConfig:create',
          method: 'post',
          data: values,
        });
        message.success('Rule created');
      }
      handleClose();
      refresh();
    } catch (e: any) {
      const msg = e?.response?.data?.errors?.[0]?.message || e.message;
      message.error(`Save failed: ${msg}`);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.request({
        url: 'orchestratorConfig:destroy',
        method: 'delete',
        params: { filterByTk: id },
      });
      message.success('Rule deleted');
      refresh();
    } catch (e: any) {
      message.error(`Delete failed: ${e.message}`);
    }
  };

  const columns = [
    {
      title: 'Leader (Orchestrator)',
      dataIndex: 'leaderUsername',
      key: 'leaderUsername',
      render: (username: string) => <Tag color="blue">{employeeMap.get(username) || username}</Tag>,
    },
    {
      title: '',
      key: 'arrow',
      width: 50,
      render: () => <SwapRightOutlined style={{ color: '#999', fontSize: 18 }} />,
    },
    {
      title: 'Sub-Agent',
      dataIndex: 'subAgentUsername',
      key: 'subAgentUsername',
      render: (username: string) => <Tag color="green">{employeeMap.get(username) || username}</Tag>,
    },
    {
      title: 'Harness',
      dataIndex: 'harnessTag',
      key: 'harnessTag',
      width: 120,
      render: (tag: string) => <Tag color="purple">{tag || 'default'}</Tag>,
    },
    {
      title: 'Max Depth',
      dataIndex: 'maxDepth',
      key: 'maxDepth',
      width: 100,
      render: (v: number) => v ?? 1,
    },
    {
      title: 'Timeout',
      dataIndex: 'timeout',
      key: 'timeout',
      width: 100,
      render: (v: number) => `${((v ?? 120000) / 1000).toFixed(0)}s`,
    },
    {
      title: 'LLM Override',
      key: 'llmOverride',
      width: 140,
      render: (_: any, record: any) => {
        if (record.llmService && record.model) {
          const svc = llmServices.find((s: any) => s.llmService === record.llmService);
          const svcName = svc ? svc.llmServiceTitle : record.llmService;
          return (
            <Space direction="vertical" size={0}>
              <Text style={{ fontSize: 12 }}>{svcName}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {record.model}
              </Text>
            </Space>
          );
        }
        return (
          <Text type="secondary" style={{ fontSize: 12 }}>
            Inherited
          </Text>
        );
      },
    },
    {
      title: 'Enabled',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 80,
      render: (enabled: boolean, record: any) => (
        <Switch
          checked={enabled}
          size="small"
          onChange={async (checked) => {
            await api.request({
              url: 'orchestratorConfig:update',
              method: 'put',
              params: { filterByTk: record.id },
              data: { enabled: checked },
            });
            refresh();
          }}
        />
      ),
    },
    {
      title: 'Tool',
      key: 'tool',
      width: 150,
      render: (_: any, record: any) => {
        const expected = expectedDelegateToolName(record.leaderUsername, record.subAgentUsername);
        const leaderTools = toolNamesMap.get(record.leaderUsername);
        if (!leaderTools) {
          return (
            <Text type="secondary" style={{ fontSize: 12 }}>
              —
            </Text>
          );
        }
        const present = leaderTools.has(expected);
        if (present) {
          return <Tag color="success">Assigned</Tag>;
        }
        return (
          <Space size={4}>
            <Tag icon={<WarningOutlined />} color="warning">
              Missing
            </Tag>
            <Button
              type="link"
              size="small"
              icon={<ThunderboltOutlined />}
              onClick={() => handleAutoAssignTool(record)}
            >
              Auto-add
            </Button>
          </Space>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
      render: (_: any, record: any) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleOpen(record)}>
            Edit
          </Button>
          <Popconfirm title="Delete this rule?" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              Delete
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const leaderUsername = Form.useWatch('leaderUsername', form);

  const missingToolCount = React.useMemo(() => {
    return rules.reduce((acc: number, r: any) => {
      const leaderTools = toolNamesMap.get(r.leaderUsername);
      if (!leaderTools) return acc;
      const expected = expectedDelegateToolName(r.leaderUsername, r.subAgentUsername);
      return leaderTools.has(expected) ? acc : acc + 1;
    }, 0);
  }, [rules, toolNamesMap]);

  const missingDispatchTools = React.useMemo(() => {
    return groupedRules
      .map((group) => {
        const leaderTools = toolNamesMap.get(group.leaderUsername);
        if (!leaderTools) return null;
        const toolName = expectedDispatchToolName(group.leaderUsername);
        return leaderTools.has(toolName)
          ? null
          : { leaderUsername: group.leaderUsername, toolName, count: group.items.length };
      })
      .filter(Boolean) as Array<{ leaderUsername: string; toolName: string; count: number }>;
  }, [groupedRules, toolNamesMap]);

  const missingControllerTools = React.useMemo(() => {
    return groupedRules
      .map((group) => {
        const leaderTools = toolNamesMap.get(group.leaderUsername);
        if (!leaderTools) return null;
        const missing = controllerToolNames.filter((toolName) => !leaderTools.has(toolName));
        return missing.length ? { leaderUsername: group.leaderUsername, missing } : null;
      })
      .filter(Boolean) as Array<{ leaderUsername: string; missing: string[] }>;
  }, [groupedRules, toolNamesMap]);

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Orchestration Rules"
        description={
          <Text type="secondary">
            Configure which AI Employees can act as Leaders (Orchestrators) and which ones they can delegate tasks to.
            Each rule creates a callable tool for the Leader to invoke the Sub-Agent.
          </Text>
        }
      />

      {missingToolCount > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`${missingToolCount} rule${missingToolCount > 1 ? 's' : ''} missing required tool assignment`}
          description={
            <Text type="secondary">
              The Leader employee hasn&apos;t added the corresponding{' '}
              <Text code>delegate_&lt;leader&gt;_to_&lt;sub&gt;</Text> tool to its skillSettings.tools, so the LLM
              cannot actually call these sub-agents. Use the <b>Auto-add</b> button in the Tool column to fix.
            </Text>
          }
        />
      )}

      {missingControllerTools.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`${missingControllerTools.length} leader${
            missingControllerTools.length > 1 ? 's' : ''
          } missing orchestrator controller tools`}
          description={
            <Space direction="vertical" size={6}>
              <Text type="secondary">
                Leaders need the orchestrator controller tools to create an approval-first plan and execute it after the
                user accepts the card.
              </Text>
              {missingControllerTools.map(({ leaderUsername, missing }) => (
                <Space key={leaderUsername} size={8} wrap>
                  <Tag color="blue">{employeeMap.get(leaderUsername) || leaderUsername}</Tag>
                  <Text type="secondary">{missing.length} missing</Text>
                  <Button
                    type="link"
                    size="small"
                    icon={<ThunderboltOutlined />}
                    onClick={() => handleAddToolsToEmployee(leaderUsername, missing)}
                  >
                    Auto-add
                  </Button>
                </Space>
              ))}
            </Space>
          }
        />
      )}

      {missingDispatchTools.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`${missingDispatchTools.length} leader${
            missingDispatchTools.length > 1 ? 's' : ''
          } missing dispatch tool assignment`}
          description={
            <Space direction="vertical" size={6}>
              <Text type="secondary">
                The fan-out tool lets a Leader dispatch multiple independent sub-tasks in one call. Add it to the
                Leader&apos;s tools to enable the new multi-agent flow.
              </Text>
              {missingDispatchTools.map(({ leaderUsername, toolName, count }) => (
                <Space key={leaderUsername} size={8} wrap>
                  <Tag color="blue">{employeeMap.get(leaderUsername) || leaderUsername}</Tag>
                  <Text type="secondary">
                    {count} sub-agent{count > 1 ? 's' : ''}
                  </Text>
                  <Text code>{toolName}</Text>
                  <Button
                    type="link"
                    size="small"
                    icon={<ThunderboltOutlined />}
                    onClick={() => handleAutoAssignDispatchTool(leaderUsername)}
                  >
                    Auto-add
                  </Button>
                </Space>
              ))}
            </Space>
          }
        />
      )}

      {aliasConflicts.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="Legacy delegate_to_<sub> alias is no longer registered for these sub-agents"
          description={
            <Space direction="vertical" size={2}>
              {aliasConflicts.map(({ sub, leaders }) => (
                <Text key={sub} type="secondary">
                  <Tag color="green">{employeeMap.get(sub) || sub}</Tag>
                  has multiple leaders ({leaders.map((l) => employeeMap.get(l) || l).join(', ')}). The legacy alias is
                  dropped to avoid ambiguity — leaders must use <Text code>delegate_&lt;leader&gt;_to_&lt;sub&gt;</Text>{' '}
                  in their tools.
                </Text>
              ))}
            </Space>
          }
        />
      )}

      <Card bordered={false}>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => handleOpen()}>
            New Rule
          </Button>
        </div>
        {groupedRules.length ? (
          <Collapse
            bordered={false}
            defaultActiveKey={groupedRules.map((group) => group.leaderUsername)}
            items={groupedRules.map((group) => ({
              key: group.leaderUsername,
              label: (
                <Space>
                  <Tag color="blue">{employeeMap.get(group.leaderUsername) || group.leaderUsername}</Tag>
                  <Text type="secondary">
                    {group.items.length} sub-agent{group.items.length > 1 ? 's' : ''}
                  </Text>
                  {missingDispatchTools.some((item) => item.leaderUsername === group.leaderUsername) && (
                    <Tag color="warning">Dispatch missing</Tag>
                  )}
                </Space>
              ),
              children: (
                <Table
                  rowKey="id"
                  loading={loading}
                  dataSource={group.items}
                  columns={columns}
                  pagination={false}
                  size="middle"
                  scroll={{ x: 'max-content' }}
                />
              ),
            }))}
          />
        ) : (
          <Table
            rowKey="id"
            loading={loading}
            dataSource={[]}
            columns={columns}
            pagination={false}
            size="middle"
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: <Empty description="No orchestration rules yet" /> }}
          />
        )}
      </Card>

      <Drawer
        title={editingRecord ? 'Edit Orchestration Rule' : 'New Orchestration Rule'}
        width={480}
        onClose={handleClose}
        open={visible}
        styles={{ body: { paddingBottom: 80 } }}
        extra={
          <Space>
            <Button onClick={handleClose}>Cancel</Button>
            <Button onClick={() => form.submit()} type="primary">
              Save
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Form.Item
            name="leaderUsername"
            label="Leader (Orchestrator)"
            rules={[{ required: true, message: 'Please select a Leader' }]}
            tooltip="The AI Employee that will be able to delegate tasks to the Sub-Agent"
          >
            <AIEmployeeSelect placeholder="Select Leader AI Employee..." />
          </Form.Item>

          <Form.Item
            name="subAgentUsername"
            label="Sub-Agent"
            rules={[{ required: true, message: 'Please select a Sub-Agent' }]}
            tooltip="The AI Employee that will receive delegated tasks"
          >
            <AIEmployeeSelect placeholder="Select Sub-Agent AI Employee..." exclude={leaderUsername} />
          </Form.Item>

          <Form.Item
            name="maxDepth"
            label="Max Delegation Depth"
            tooltip="How many layers of delegation are allowed (1 = leader calls sub-agent, sub-agent cannot delegate further)"
          >
            <InputNumber min={1} max={3} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item
            name="timeout"
            label="Timeout (ms)"
            tooltip="Maximum time in milliseconds for the sub-agent to complete its task"
          >
            <InputNumber min={10000} max={600000} step={10000} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item
            name="recursionLimit"
            label="Recursion Limit"
            tooltip="Max LangGraph reasoning steps per delegation. Higher = more complex multi-step tasks; lower = stricter cap on token usage. Default 50."
          >
            <InputNumber min={5} max={200} step={5} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item
            name="harnessTag"
            label="Harness Profile"
            tooltip="Profile tag used by plan approval, controller limits, and orchestration policy."
          >
            <Select
              loading={harnessLoading}
              options={[
                { label: 'default', value: 'default' },
                ...harnessProfiles
                  .filter((profile: any) => profile.tag !== 'default')
                  .map((profile: any) => ({
                    label: profile.title ? `${profile.tag} - ${profile.title}` : profile.tag,
                    value: profile.tag,
                  })),
              ]}
            />
          </Form.Item>

          <Form.Item
            name="llmService"
            label="Override LLM Service"
            tooltip="Optional: Provider name. Leave empty to inherit from Leader."
          >
            <Select
              allowClear
              placeholder="Inherit from Leader"
              loading={llmLoading}
              options={llmServices.map((svc: any) => ({
                label: svc.llmServiceTitle || svc.llmService,
                value: svc.llmService,
              }))}
              onChange={() => form.setFieldValue('model', undefined)}
            />
          </Form.Item>

          <Form.Item
            noStyle
            shouldUpdate={(prevValues, currentValues) => prevValues.llmService !== currentValues.llmService}
          >
            {() => {
              const selectedServiceId = form.getFieldValue('llmService');
              const selectedService = llmServices.find((s: any) => s.llmService === selectedServiceId);
              const availableModels = Array.isArray(selectedService?.enabledModels)
                ? selectedService.enabledModels
                : [];

              return (
                <Form.Item
                  name="model"
                  label="Override Model"
                  tooltip="Optional: Model name. Leave empty to inherit from Leader."
                  rules={[{ required: !!selectedServiceId, message: 'Please select a model' }]}
                >
                  <Select
                    allowClear
                    placeholder={selectedServiceId ? 'Select a model' : 'Inherit from Leader'}
                    disabled={!selectedServiceId}
                    options={availableModels.map((m: any) => ({
                      label: m.label,
                      value: m.value,
                    }))}
                  />
                </Form.Item>
              );
            }}
          </Form.Item>

          <Form.Item name="enabled" label="Enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
};
