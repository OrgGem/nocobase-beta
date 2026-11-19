// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Button, Form, type FormInstance } from 'antd';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import PluginAIClientV2 from '@nocobase/plugin-ai/client-v2';
import { PluginCustomLLMClient, customLLMProviderOptions } from '../plugin';
import { ProviderSettingsForm } from '../settings';

const { apiClientRequest } = vi.hoisted(() => ({ apiClientRequest: vi.fn() }));

vi.mock('@nocobase/client-v2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nocobase/client-v2')>()),
  useApp: () => ({ apiClient: { request: apiClientRequest } }),
}));

function renderSettings(options: Record<string, unknown>, onFinish = vi.fn()) {
  const formRef = React.createRef<FormInstance>();
  render(
    <Form ref={formRef} initialValues={{ options }} onFinish={onFinish}>
      <ProviderSettingsForm />
      <Button htmlType="submit">Save</Button>
    </Form>,
  );

  return { formRef, onFinish };
}

describe('modern Custom LLM provider settings', () => {
  it('defaults new services to automatic API mode and no Claude aliases', () => {
    renderSettings({ apiKey: 'local-test-key' });

    expect(screen.getByText('Automatic')).toBeInTheDocument();
    expect(screen.getByText('Enter exact model aliases')).toBeInTheDocument();
  });

  it('loads and saves Chat Completions mode and exact Claude aliases', async () => {
    const onFinish = vi.fn();
    renderSettings(
      {
        apiKey: 'local-test-key',
        apiMode: 'chat-completions',
        claudeModelAliases: ['claude-sonnet-internal', 'claude-opus-internal'],
      },
      onFinish,
    );

    expect(screen.getByText('Chat Completions')).toBeInTheDocument();
    expect(screen.getByText('claude-sonnet-internal')).toBeInTheDocument();
    expect(screen.getByText('claude-opus-internal')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            apiMode: 'chat-completions',
            claudeModelAliases: ['claude-sonnet-internal', 'claude-opus-internal'],
          }),
        }),
      );
    });
  });

  it('registers the shared provider settings form in the modern AI client', async () => {
    const registerLLMProvider = vi.fn();
    const app = {
      pm: {
        get: vi.fn(() => ({ aiManager: { registerLLMProvider } })),
      },
    };
    const plugin = new PluginCustomLLMClient(
      {},
      app as unknown as ConstructorParameters<typeof PluginCustomLLMClient>[1],
    );

    await plugin.load();

    expect(app.pm.get).toHaveBeenCalledWith(PluginAIClientV2);
    expect(registerLLMProvider).toHaveBeenCalledWith('custom-llm', customLLMProviderOptions);
    expect(customLLMProviderOptions.components.ProviderSettingsForm).toBe(ProviderSettingsForm);
  });
});
