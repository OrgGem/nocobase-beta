/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FileTextOutlined, RobotOutlined } from '@ant-design/icons';
import { Button, Dropdown, Space, Tooltip, message } from 'antd';
import type { MenuProps } from 'antd';
import type { Application } from '@nocobase/client';
import { useChatBoxActions, useAIConfigRepository, type AIEmployee } from '@nocobase/plugin-ai/client';
import { useT } from './locale';

export const FILE_PREVIEW_WORK_CONTEXT_TYPE = 'file-preview';

const AI_EMPLOYEE_STORAGE_KEY = 'plugin-file-preview-auth.aiEmployee';

function getFileDisplayName(file: any): string {
  if (!file) return 'file';
  if (file.title && file.extname) return `${file.title}${file.extname}`;
  return file.filename || file.name || file.title || 'file';
}

function getFileContextUid(file: any): string {
  const stableValue = file?.id ?? file?.uid ?? file?.url ?? file?.path ?? getFileDisplayName(file);
  return `file-preview:${String(stableValue)}`;
}

function normalizePreviewFile(file: any) {
  return {
    id: file?.id,
    uid: file?.uid,
    url: file?.url,
    preview: file?.preview,
    filename: file?.filename || file?.name,
    name: file?.name || file?.filename,
    title: file?.title,
    extname: file?.extname,
    mimetype: file?.mimetype,
    size: file?.size,
    path: file?.path,
    storageId: file?.storageId ?? file?.storage_id ?? file?.storage?.id,
    storage_id: file?.storage_id,
    storageType: file?.storageType || file?.storage?.type,
    storageName: file?.storageName || file?.storage?.name,
    storage: file?.storage,
    collectionName: file?.collectionName,
  };
}

export function createFilePreviewWorkContext(file: any) {
  return {
    type: FILE_PREVIEW_WORK_CONTEXT_TYPE,
    uid: getFileContextUid(file),
    title: getFileDisplayName(file),
    content: {
      source: 'plugin-file-preview-auth',
      file: normalizePreviewFile(file),
    },
  };
}

function getStoredAIEmployeeUsername() {
  try {
    return window.localStorage.getItem(AI_EMPLOYEE_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function setStoredAIEmployeeUsername(username: string) {
  try {
    window.localStorage.setItem(AI_EMPLOYEE_STORAGE_KEY, username);
  } catch {
    // Ignore storage restrictions in embedded/sandboxed clients.
  }
}

function getEmployeeLabel(employee: AIEmployee) {
  return employee?.nickname || employee?.username || '';
}

class AIFilePreviewActionBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return null;
    }
    return this.props.children;
  }
}

const AIFilePreviewActionInner: React.FC<{ file: any }> = ({ file }) => {
  const t = useT();
  const aiConfigRepository = useAIConfigRepository();
  const { triggerTask } = useChatBoxActions();
  const [employees, setEmployees] = useState<AIEmployee[]>([]);
  const [loading, setLoading] = useState(false);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!aiConfigRepository?.getAIEmployees) {
      return;
    }

    const cached = aiConfigRepository.aiEmployees || [];
    if (cached.length) {
      setEmployees([...cached]);
      return;
    }

    setLoading(true);
    aiConfigRepository
      .getAIEmployees()
      .then((list) => {
        if (!cancelled) {
          setEmployees([...(list || [])]);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEmployees([]);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [aiConfigRepository]);

  const orderedEmployees = useMemo(() => {
    const selected = getStoredAIEmployeeUsername();
    if (!selected) {
      return employees;
    }
    return [...employees].sort((a, b) => {
      if (a.username === selected) return -1;
      if (b.username === selected) return 1;
      return 0;
    });
  }, [employees]);

  const openAIChat = useCallback(
    async (employee: AIEmployee) => {
      if (!employee || !file) {
        return;
      }

      setAsking(true);
      try {
        setStoredAIEmployeeUsername(employee.username);
        await triggerTask({
          aiEmployee: employee,
          tasks: [
            {
              title: getFileDisplayName(file),
              message: {
                user: t('Please help me analyze the file currently open in preview.'),
                workContext: [createFilePreviewWorkContext(file)],
              },
              autoSend: false,
            },
          ],
        });
      } catch {
        message.error(t('Failed to open AI chat'));
      } finally {
        setAsking(false);
      }
    },
    [file, t, triggerTask],
  );

  const menuItems: MenuProps['items'] = orderedEmployees.map((employee) => ({
    key: employee.username,
    label: getEmployeeLabel(employee),
    onClick: () => openAIChat(employee),
  }));

  if (!loading && !orderedEmployees.length) {
    return null;
  }

  if (orderedEmployees.length === 1) {
    return (
      <Tooltip title={t('Ask AI')}>
        <Button
          type="text"
          size="small"
          icon={<RobotOutlined />}
          loading={asking || loading}
          onClick={(event) => {
            event.stopPropagation();
            openAIChat(orderedEmployees[0]);
          }}
        >
          {t('Ask AI')}
        </Button>
      </Tooltip>
    );
  }

  return (
    <Tooltip title={t('Ask AI')}>
      <Dropdown menu={{ items: menuItems }} trigger={['click']} placement="bottomRight" disabled={asking || loading}>
        <Button
          type="text"
          size="small"
          icon={<RobotOutlined />}
          loading={asking || loading}
          onClick={(event) => event.stopPropagation()}
        >
          {t('Ask AI')}
        </Button>
      </Dropdown>
    </Tooltip>
  );
};

export const AIFilePreviewAction: React.FC<{ file: any }> = ({ file }) => {
  return (
    <AIFilePreviewActionBoundary>
      <AIFilePreviewActionInner file={file} />
    </AIFilePreviewActionBoundary>
  );
};

export function registerFilePreviewAIWorkContext(app: Application) {
  let aiPlugin: any;
  try {
    aiPlugin = app.pm.get('ai') as any;
  } catch {
    return;
  }
  const aiManager = aiPlugin?.aiManager;
  if (!aiManager?.registerWorkContext) {
    return;
  }

  const options = {
    name: FILE_PREVIEW_WORK_CONTEXT_TYPE,
    tag: {
      Component: ({ item }: { item: any }) => (
        <Space>
          <FileTextOutlined />
          <span>{item?.title || ''}</span>
        </Space>
      ),
    },
    chatbox: {
      Component: ({ item }: { item: any }) => (
        <Space>
          <FileTextOutlined />
          <span>{item?.title || ''}</span>
        </Space>
      ),
    },
  };

  try {
    if (!aiManager.getWorkContext?.(FILE_PREVIEW_WORK_CONTEXT_TYPE)) {
      aiManager.registerWorkContext(FILE_PREVIEW_WORK_CONTEXT_TYPE, options);
    }
  } catch {
    // Duplicate registration can happen during hot reload. It is harmless.
  }
}
