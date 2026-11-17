// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbedSettingsPluginSelect } from '../EmbedSettingsPluginSelect';

type ReactAclState = {
  data?: { data?: { role?: string } };
  error?: unknown;
  loading?: boolean;
};

type PluginSetting = {
  name: string;
  title: string;
  Component?: React.ComponentType;
};

type AppFixture = {
  context: { acl: { data: { role: string; snippets: string[]; allowAll: boolean } } };
  apiClient: {
    auth: { role?: string };
    request: () => Promise<{ data: unknown }>;
  };
  eventBus: {
    addEventListener: (event: string, listener: EventListener) => void;
    removeEventListener: (event: string, listener: EventListener) => void;
  };
  pluginSettingsManager: {
    getList: () => PluginSetting[];
    has: (name: string) => boolean;
    get: (name: string) => PluginSetting | undefined;
  };
};

const testState = vi.hoisted(() => ({
  app: undefined as unknown,
  reactAcl: undefined as unknown,
  aclValid: true,
}));

vi.mock('@nocobase/client', () => ({
  useACLContext: () => testState.reactAcl,
}));

vi.mock('@nocobase/client-v2', () => ({
  useApp: () => testState.app,
}));

vi.mock('../../shared/useRolesCheckRefresh', () => ({
  useRolesCheckRefresh: () => ({ valid: testState.aclValid }),
}));

const enabledPluginResponse = {
  data: [
    { pluginName: 'ai-orchestrator', title: 'Agent Orchestrator' },
    { pluginName: 'ai-api', title: 'AI API Gateway' },
    { pluginName: 'ai', title: 'AI employees' },
    { pluginName: 'api-doc', title: 'API documentation' },
    { pluginName: 'api-keys', title: 'API keys' },
    { pluginName: 'file-manager', title: 'File manager' },
    { pluginName: 'git-manager', title: 'Git Manager' },
    { pluginName: 'license-settings', title: 'License settings' },
    { pluginName: 'n8n', title: 'n8n Integration' },
  ],
};

function createApp(apiRole: string | undefined, contextRole = 'root'): AppFixture {
  const settings: PluginSetting[] = [
    { name: 'ai-orchestrator', title: 'Agent Orchestrator', Component: () => null },
    { name: 'ai-api', title: 'AI API Gateway', Component: () => null },
    { name: 'ai', title: 'AI employees', Component: () => null },
    { name: 'api-doc', title: 'API documentation' },
    { name: 'not-allowlisted', title: 'Not allowlisted', Component: () => null },
  ];

  return {
    context: {
      acl: { data: { role: contextRole, snippets: ['pm', 'pm.*', 'ui.*'], allowAll: true } },
    },
    apiClient: {
      auth: { role: apiRole },
      request: async () => ({ data: enabledPluginResponse }),
    },
    eventBus: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
    pluginSettingsManager: {
      getList: () => settings,
      has: (name) => settings.some((setting) => setting.name === name),
      get: (name) => settings.find((setting) => setting.name === name),
    },
  };
}

async function openPluginOptions() {
  const user = userEvent.setup();
  render(<EmbedSettingsPluginSelect placeholder="Select plugin" />);
  const selector = screen.getByRole('combobox');
  await waitFor(() => expect(selector).toBeEnabled());
  await act(async () => {
    await user.click(selector);
  });
  return selector;
}

describe('EmbedSettingsPluginSelect in the detached FlowSettings ACL context', () => {
  beforeEach(() => {
    testState.app = createApp('root');
    testState.reactAcl = {};
    testState.aclValid = true;
  });

  it('shows registered, allowlisted plugin settings using the current app ACL role', async () => {
    await openPluginOptions();

    expect(await screen.findByText('Agent Orchestrator', {}, { timeout: 1000 })).toBeInTheDocument();
    expect(screen.getByText('AI API Gateway')).toBeInTheDocument();
    expect(screen.getByText('AI employees')).toBeInTheDocument();
    expect(screen.queryByText('API documentation')).not.toBeInTheDocument();
    expect(screen.queryByText('Not allowlisted')).not.toBeInTheDocument();
  });

  it.each([
    ['stale app role after the API role is removed', () => (testState.app = createApp(undefined))],
    ['stale app role after the authenticated role changes', () => (testState.app = createApp('editor'))],
    ['explicit ACL context error', () => (testState.reactAcl = { error: new Error('ACL unavailable') })],
    ['explicit ACL context without a role', () => (testState.reactAcl = { data: { data: {} } })],
    ['invalidated roles check', () => (testState.aclValid = false)],
  ])('fails closed for %s', async (_caseName, configureCase) => {
    configureCase();
    await openPluginOptions();

    expect(screen.queryByText('Agent Orchestrator')).not.toBeInTheDocument();
    expect(screen.getAllByText('No data').length).toBeGreaterThan(0);
  });
});
