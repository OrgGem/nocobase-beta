import React, { useState, useEffect, useCallback } from 'react';
import {
  Card,
  Button,
  Space,
  Modal,
  Form,
  Input,
  Select,
  Switch,
  InputNumber,
  message,
  Popconfirm,
  Tag,
  List,
  Typography,
  Tooltip,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, PlayCircleOutlined, BranchesOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useT } from '../locale';
import { SkillEditor } from './SkillEditor';
import { SkillTestPanel } from './SkillTestPanel';
import { GitSkillImport } from './GitSkillImport';

const { TextArea } = Input;

export const SkillManager: React.FC = () => {
  const api = useApp().apiClient;
  const t = useT();
  const [skills, setSkills] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [editorVisible, setEditorVisible] = useState(false);
  const [testVisible, setTestVisible] = useState(false);
  const [editingSkill, setEditingSkill] = useState<any>(null);
  const [testingSkill, setTestingSkill] = useState<any>(null);
  const [gitImportVisible, setGitImportVisible] = useState(false);

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.request({ url: 'skillDefinitions:list', params: { pageSize: 100 } });
      const rawData = data?.data?.data ?? data?.data ?? [];
      setSkills(Array.isArray(rawData) ? rawData : []);
    } catch {
      message.error(t('Failed to load skills'));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const handleCreate = () => {
    setEditingSkill(null);
    setEditorVisible(true);
  };

  const handleEdit = (record: any) => {
    setEditingSkill(record);
    setEditorVisible(true);
  };

  const handleTest = (record: any) => {
    setTestingSkill(record);
    setTestVisible(true);
  };

  const handleDelete = async (id: number) => {
    try {
      await api.request({ url: 'skillDefinitions:destroy', method: 'POST', params: { filterByTk: id } });
      message.success(t('Deleted'));
      fetchSkills();
    } catch {
      message.error(t('Failed to delete'));
    }
  };

  const handleToggleEnabled = async (record: any) => {
    try {
      await api.request({
        url: 'skillDefinitions:update',
        method: 'POST',
        params: { filterByTk: record.id },
        data: { enabled: !record.enabled },
      });
      fetchSkills();
    } catch {
      message.error(t('Failed to update'));
    }
  };

  const handleEditorClose = (saved?: boolean) => {
    setEditorVisible(false);
    setEditingSkill(null);
    if (saved) fetchSkills();
  };

  // Table columns definition removed in favor of List rendering

  return (
    <Card
      title={t('Skill Definitions')}
      extra={
        <Space>
          <Button icon={<BranchesOutlined />} onClick={() => setGitImportVisible(true)}>
            {t('Import from Git')}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
            {t('New Skill')}
          </Button>
        </Space>
      }
    >
      <List
        grid={{ gutter: 16, xs: 1, sm: 2, md: 3, lg: 3, xl: 4, xxl: 4 }}
        dataSource={skills}
        loading={loading}
        renderItem={(skill) => (
          <List.Item>
            <Card
              size="small"
              title={
                <Typography.Text ellipsis title={skill.title}>
                  {skill.title}
                </Typography.Text>
              }
              extra={<Tag color={skill.language === 'python' ? 'blue' : 'green'}>{skill.language}</Tag>}
              actions={[
                <Tooltip key="test" title={t('Test')}>
                  <PlayCircleOutlined onClick={() => handleTest(skill)} />
                </Tooltip>,
                <Tooltip key="edit" title={t('Edit')}>
                  <EditOutlined onClick={() => handleEdit(skill)} />
                </Tooltip>,
                <Popconfirm key="delete" title={t('Delete?')} onConfirm={() => handleDelete(skill.id)}>
                  <Tooltip title={t('Delete')}>
                    <DeleteOutlined style={{ color: 'red' }} />
                  </Tooltip>
                </Popconfirm>,
              ]}
              style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.05)', borderRadius: 8 }}
            >
              <Card.Meta
                title={
                  <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                    {skill.name}
                  </Typography.Text>
                }
                description={
                  <div
                    style={{
                      height: 60,
                      overflow: 'hidden',
                      display: '-webkit-box',
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: 'vertical',
                      fontSize: 13,
                    }}
                  >
                    {skill.description || t('No description')}
                  </div>
                }
              />
              <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Space size={4}>
                  <Switch checked={skill.enabled} onChange={() => handleToggleEnabled(skill)} size="small" />
                  <span style={{ fontSize: 12 }}>{skill.enabled ? t('Enabled') : t('Disabled')}</span>
                </Space>
                <Tag color="purple" style={{ margin: 0, fontSize: 11 }}>
                  {skill.storageType ? skill.storageType.toUpperCase() : 'DB'}
                </Tag>
              </div>
            </Card>
          </List.Item>
        )}
      />

      {editorVisible && <SkillEditor skill={editingSkill} onClose={handleEditorClose} />}

      {testVisible && testingSkill && <SkillTestPanel skill={testingSkill} onClose={() => setTestVisible(false)} />}

      <GitSkillImport
        open={gitImportVisible}
        onClose={(synced) => {
          setGitImportVisible(false);
          if (synced) fetchSkills();
        }}
      />
    </Card>
  );
};
