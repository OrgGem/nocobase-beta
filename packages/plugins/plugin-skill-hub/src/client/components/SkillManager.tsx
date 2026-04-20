import React, { useState, useEffect, useCallback } from 'react';
import {
  Card,
  Table,
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
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useT } from '../locale';
import { SkillEditor } from './SkillEditor';
import { SkillTestPanel } from './SkillTestPanel';

const { TextArea } = Input;

export const SkillManager: React.FC = () => {
  const api = useAPIClient();
  const t = useT();
  const [skills, setSkills] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [editorVisible, setEditorVisible] = useState(false);
  const [testVisible, setTestVisible] = useState(false);
  const [editingSkill, setEditingSkill] = useState<any>(null);
  const [testingSkill, setTestingSkill] = useState<any>(null);

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.request({ url: 'skillDefinitions:list', params: { pageSize: 100 } });
      setSkills(data?.data || []);
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

  const columns = [
    {
      title: t('Name'),
      dataIndex: 'name',
      key: 'name',
      width: 180,
    },
    {
      title: t('Title'),
      dataIndex: 'title',
      key: 'title',
      width: 200,
    },
    {
      title: t('Description'),
      dataIndex: 'description',
      key: 'description',
      width: 250,
      ellipsis: true,
    },
    {
      title: t('Language'),
      dataIndex: 'language',
      key: 'language',
      width: 100,
      render: (lang: string) => (
        <Tag color={lang === 'python' ? 'blue' : 'green'}>{lang}</Tag>
      ),
    },
    {
      title: t('Timeout'),
      dataIndex: 'timeoutSeconds',
      key: 'timeoutSeconds',
      width: 100,
      render: (v: number) => `${v}s`,
    },
    {
      title: t('Enabled'),
      dataIndex: 'enabled',
      key: 'enabled',
      width: 100,
      render: (enabled: boolean, record: any) => (
        <Switch checked={enabled} onChange={() => handleToggleEnabled(record)} size="small" />
      ),
    },
    {
      title: t('Actions'),
      key: 'actions',
      width: 200,
      render: (_: any, record: any) => (
        <Space size="small">
          <Button type="link" size="small" icon={<PlayCircleOutlined />} onClick={() => handleTest(record)}>
            {t('Test')}
          </Button>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            {t('Edit')}
          </Button>
          <Popconfirm title={t('Delete this skill?')} onConfirm={() => handleDelete(record.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              {t('Delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={t('Skill Definitions')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
          {t('New Skill')}
        </Button>
      }
    >
      <Table
        dataSource={skills}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={false}
        size="middle"
        scroll={{ x: 'max-content' }}
      />

      {editorVisible && (
        <SkillEditor skill={editingSkill} onClose={handleEditorClose} />
      )}

      {testVisible && testingSkill && (
        <SkillTestPanel skill={testingSkill} onClose={() => setTestVisible(false)} />
      )}
    </Card>
  );
};
