// SPDX-License-Identifier: Apache-2.0

import { FlowContext, FlowContextProvider, type PropertyMeta } from '@nocobase/flow-engine';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Button, Form } from 'antd';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { customLLMProviderOptions } from '../llm-providers/custom-llm';

function createContextWithEnv() {
  const context = new FlowContext();
  context.defineMethod('t', (key: string) => key);
  context.defineProperty('$env', {
    value: { API_KEY: 'local-test-key' },
    meta: {
      title: 'Env',
      type: 'object',
      properties: {
        API_KEY: { title: 'Provider token', type: 'string' } as PropertyMeta,
      },
    },
  });
  return context;
}

describe('legacy Custom LLM provider settings', () => {
  it('lists and saves a selected environment variable', async () => {
    const onFinish = vi.fn();
    const ProviderSettings = customLLMProviderOptions.components.ProviderSettingsForm;
    expect(ProviderSettings).toBeDefined();
    if (!ProviderSettings) return;

    render(
      <FlowContextProvider context={createContextWithEnv()}>
        <Form onFinish={onFinish}>
          <ProviderSettings />
          <Button htmlType="submit">Save</Button>
        </Form>
      </FlowContextProvider>,
    );

    const apiKeyField = screen.getByRole('textbox', { name: 'textbox' });
    const apiKeyItem = apiKeyField.closest('.ant-form-item');
    expect(apiKeyItem).not.toBeNull();
    fireEvent.click(within(apiKeyItem as HTMLElement).getByRole('button'));
    fireEvent.click(await screen.findByText('Env'));
    fireEvent.click(await screen.findByText('Provider token'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ options: expect.objectContaining({ apiKey: '{{ $env.API_KEY }}' }) }),
      );
    });
  });

  it('loads an environment API key and preserves it when saving another provider option', async () => {
    const onFinish = vi.fn();
    const ProviderSettings = customLLMProviderOptions.components.ProviderSettingsForm;
    expect(ProviderSettings).toBeDefined();
    if (!ProviderSettings) return;

    render(
      <FlowContextProvider context={createContextWithEnv()}>
        <Form initialValues={{ options: { apiKey: '{{ $env.API_KEY }}', disableStream: false } }} onFinish={onFinish}>
          <ProviderSettings />
          <Button htmlType="submit">Save</Button>
        </Form>
      </FlowContextProvider>,
    );

    await waitFor(() => {
      expect(
        screen.getByText((_, node) => node?.textContent === 'Env/Provider token' && node.tagName === 'SPAN'),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Disable streaming' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ apiKey: '{{ $env.API_KEY }}', disableStream: true }),
        }),
      );
    });
  });

  it('masks a saved literal API key while keeping it in the form submission', async () => {
    const onFinish = vi.fn();
    const ProviderSettings = customLLMProviderOptions.components.ProviderSettingsForm;
    expect(ProviderSettings).toBeDefined();
    if (!ProviderSettings) return;

    render(
      <FlowContextProvider context={createContextWithEnv()}>
        <Form initialValues={{ options: { apiKey: 'local-test-key' } }} onFinish={onFinish}>
          <ProviderSettings />
          <Button htmlType="submit">Save</Button>
        </Form>
      </FlowContextProvider>,
    );

    const input = await screen.findByDisplayValue('local-test-key');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ options: expect.objectContaining({ apiKey: 'local-test-key' }) }),
      );
    });
  });
});
