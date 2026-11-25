// SPDX-License-Identifier: Apache-2.0

import { BranchesOutlined, MergeOutlined, NodeIndexOutlined } from '@ant-design/icons';
import type { AIManager, ContextItem } from '@nocobase/plugin-ai/client-v2';
import { Registry } from '@nocobase/utils/client';
import { message, Space } from 'antd';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { GitContextPicker } from './components/GitContextPicker';
import { actionData, fetchGitContext, type GitContextApp, type GitContextKind } from './git-context-api';

type WorkContextOptions = Parameters<AIManager['registerWorkContext']>[1];
type ContextCapabilities = Record<GitContextKind, boolean>;

const kinds: GitContextKind[] = ['repository', 'merge-request', 'commit'];
const emptyCapabilities = (): ContextCapabilities => ({ repository: false, 'merge-request': false, commit: false });
const registrations = new WeakMap<AIManager, Promise<void>>();

function ContextLabel({ kind, title }: { kind: GitContextKind; title?: string }) {
  const { t } = useTranslation('plugin-git-manager');
  const labels = { repository: 'Git Repository', 'merge-request': 'Git Merge Request', commit: 'Git Commit' };
  const icons = { repository: <BranchesOutlined />, 'merge-request': <MergeOutlined />, commit: <NodeIndexOutlined /> };
  return (
    <Space size={4}>
      {icons[kind]}
      <span>{title || t(labels[kind])}</span>
    </Space>
  );
}

function contextDefinition(app: GitContextApp, kind: GitContextKind): WorkContextOptions {
  return {
    name: `git-${kind}`,
    tag: {
      Component: ({ item }: { item: ContextItem }) => <ContextLabel kind={kind} title={item.title || item.uid} />,
    },
    getContent: async (currentApp, { uid }) => {
      try {
        return await fetchGitContext(app, kind, uid);
      } catch (error) {
        message.error(
          currentApp.i18n.t('Git context is unavailable. Check your access and select it again.', {
            ns: 'plugin-git-manager',
          }),
        );
        throw error;
      }
    },
  };
}

function contextMenu(
  app: GitContextApp,
  kind: GitContextKind,
  isAllowed: () => boolean,
): NonNullable<WorkContextOptions['menu']> {
  return {
    Component: () => <ContextLabel kind={kind} />,
    onClick: ({ ctx, onAdd }) => {
      if (!isAllowed()) return;
      let active = true;
      const dialog = ctx.viewer.dialog({
        title: <ContextLabel kind={kind} />,
        width: 720,
        zIndex: 2200,
        onClose: () => {
          active = false;
        },
        content: () => (
          <GitContextPicker
            app={app}
            kind={kind}
            onAdd={onAdd}
            isActive={() => active && isAllowed()}
            onClose={() => {
              dialog.close();
            }}
          />
        ),
      });
    },
  };
}

/** Register readers even when the current role cannot add Git context. */
export function registerGitWorkContexts(app: GitContextApp, manager: AIManager): Promise<void> {
  let registration = registrations.get(manager);
  if (!registration) {
    registration = initializeGitWorkContexts(app, manager);
    registrations.set(manager, registration);
  }
  return registration;
}

async function initializeGitWorkContexts(app: GitContextApp, manager: AIManager): Promise<void> {
  let capabilities = emptyCapabilities();
  let requestSequence = 0;

  for (const kind of kinds) {
    const name = `git-${kind}`;
    if (!manager.getWorkContext(name)) manager.registerWorkContext(name, contextDefinition(app, kind));
  }

  const updateMenus = () => {
    const registry = new Registry<WorkContextOptions>();
    for (const [name, existing] of manager.workContext.getEntities()) {
      const kind = kinds.find((item) => name === `git-${item}`);
      if (!kind) {
        registry.register(name, existing);
        continue;
      }
      const { menu: _menu, ...definition } = existing;
      registry.register(name, {
        ...definition,
        ...(capabilities[kind] ? { menu: contextMenu(app, kind, () => capabilities[kind]) } : {}),
      });
    }
    manager.workContext = registry;
  };

  const refresh = async () => {
    const sequence = ++requestSequence;
    capabilities = emptyCapabilities();
    updateMenus();
    if (app.apiClient.auth && !app.apiClient.auth.token) return;
    try {
      const result = actionData(
        await app.apiClient.request({ url: 'gitManager:chatContextOptions', skipNotify: true, timeout: 5000 }),
      ) as { capabilities?: Partial<ContextCapabilities> } | undefined;
      if (sequence !== requestSequence) return;
      capabilities = {
        repository: result?.capabilities?.repository === true,
        'merge-request': result?.capabilities?.['merge-request'] === true,
        commit: result?.capabilities?.commit === true,
      };
      updateMenus();
    } catch {
      // A failed capability request keeps all menu entries hidden.
    }
  };

  app.eventBus.addEventListener('auth:tokenChanged', () => {
    refresh();
  });
  const client = app.apiClient as typeof app.apiClient & {
    axios?: {
      interceptors?: {
        response?: {
          use: (handler: (response: { config?: { url?: string } }) => { config?: { url?: string } }) => unknown;
        };
      };
    };
  };
  client.axios?.interceptors?.response?.use((response) => {
    if (/(^|\/)roles:check(?:\?|$)/.test(response.config?.url || '')) {
      // ACLRolesCheckProvider applies the returned role after this interceptor resolves.
      setTimeout(() => refresh(), 0);
    }
    return response;
  });
  await refresh();
}
