import { FileTextOutlined, RobotOutlined } from '@ant-design/icons';
import { useApp, type Application } from '@nocobase/client-v2';
import type PluginAIClientV2 from '@nocobase/plugin-ai/client-v2';
import { useAIConfigRepository, type AIEmployee, type ContextItem } from '@nocobase/plugin-ai/client-v2';
import { App, Button, Space, Tooltip } from 'antd';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { createFilePreviewWorkContext, FILE_PREVIEW_WORK_CONTEXT_TYPE } from './filePreviewContext';
const STORAGE_KEY = 'plugin-file-preview-auth.aiEmployee';

export function registerFilePreviewAIWorkContext(app: Application) {
  const manager = app.pm.get<PluginAIClientV2>('ai')?.aiManager;
  if (!manager || manager.getWorkContext(FILE_PREVIEW_WORK_CONTEXT_TYPE)) return;
  const Component = ({ item }: { item: ContextItem }) => (
    <Space>
      <FileTextOutlined />
      <span>{item.title}</span>
    </Space>
  );
  manager.registerWorkContext(FILE_PREVIEW_WORK_CONTEXT_TYPE, {
    name: FILE_PREVIEW_WORK_CONTEXT_TYPE,
    tag: { Component },
    chatbox: { Component },
  });
}

export default function AIFilePreviewAction({ file }: { file: unknown }) {
  const app = useApp();
  const repository = useAIConfigRepository();
  const manager = app.pm.get<PluginAIClientV2>('ai')?.aiManager;
  const { t } = useTranslation('plugin-file-preview-auth');
  const { message } = App.useApp();
  const [employees, setEmployees] = useState<AIEmployee[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!manager || !repository) return;
    let active = true;
    async function loadEmployees() {
      setLoading(true);
      try {
        const list = repository.aiEmployees?.length ? repository.aiEmployees : await repository.getAIEmployees();
        if (active) setEmployees([...list]);
      } catch {
        if (active) setEmployees([]);
      } finally {
        if (active) setLoading(false);
      }
    }
    loadEmployees();
    return () => {
      active = false;
    };
  }, [manager, repository]);

  const openAIChat = () => {
    if (!manager || !employees.length) return;
    let preferred = '';
    try {
      preferred = window.localStorage.getItem(STORAGE_KEY) || '';
    } catch {
      /* Storage may be disabled. */
    }
    const employee = employees.find((item) => item.username === preferred) || employees[0];
    try {
      window.localStorage.setItem(STORAGE_KEY, employee.username);
    } catch {
      /* Storage may be disabled. */
    }
    try {
      const context = createFilePreviewWorkContext(file);
      manager.triggerTask({
        aiEmployee: employee,
        tasks: [
          {
            title: context.title,
            message: { user: t('Please help me analyze the file currently open in preview.'), workContext: [context] },
            autoSend: false,
          },
        ],
      });
    } catch {
      message.error(t('Failed to open AI chat'));
    }
  };

  if (!manager || (!loading && !employees.length)) return null;
  return (
    <Tooltip title={t('Ask AI')}>
      <Button type="text" icon={<RobotOutlined />} loading={loading} disabled={!employees.length} onClick={openAIChat}>
        {t('Ask AI')}
      </Button>
    </Tooltip>
  );
}
