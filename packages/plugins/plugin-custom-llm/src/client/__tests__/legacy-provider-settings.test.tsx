// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button, Form, type FormInstance } from 'antd';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { customLLMProviderOptions } from '../llm-providers/custom-llm';

const { apiClientRequest } = vi.hoisted(() => ({ apiClientRequest: vi.fn() }));

vi.mock('@nocobase/client-v2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nocobase/client-v2')>()),
  useApp: () => ({ apiClient: { request: apiClientRequest } }),
}));

const ProviderSettings = customLLMProviderOptions.components.ProviderSettingsForm;

function renderSettings(options: Record<string, unknown> = {}, onFinish = vi.fn()) {
  const formRef = React.createRef<FormInstance>();
  const result = render(
    <Form ref={formRef} initialValues={{ options }} onFinish={onFinish}>
      <ProviderSettings />
      <Button htmlType="submit">Save</Button>
    </Form>,
  );

  return { ...result, formRef, onFinish };
}

function ReopenableProviderSettings() {
  const [open, setOpen] = React.useState(true);
  return (
    <>
      {open ? <ProviderSettings /> : null}
      <Button onClick={() => setOpen(false)}>Close settings</Button>
      <Button onClick={() => setOpen(true)}>Reopen settings</Button>
    </>
  );
}

const getEnvSelect = () => screen.getByRole('combobox', { name: 'Select environment variable' });

const findEnvOption = (name: string) => screen.findByText(name, { selector: '.ant-select-item-option-content' });

const openEnvSelect = () => fireEvent.mouseDown(getEnvSelect());

describe('legacy Custom LLM provider settings', () => {
  beforeEach(() => {
    apiClientRequest.mockReset();
    apiClientRequest.mockResolvedValue({
      data: {
        data: [
          // Secret values are never needed by the picker; it only receives names.
          { name: 'API_KEY', type: 'secret', value: 'secret-test-value' },
          { name: 'BASE_URL', type: 'default' },
        ],
      },
    });
  });

  it('loads variable names from the environment API and saves the selected variable reference', async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    const { formRef } = renderSettings({}, onFinish);

    await user.click(getEnvSelect());
    await user.click(await findEnvOption('API_KEY'));
    await waitFor(() => {
      expect(formRef.current?.getFieldValue(['options', 'apiKey'])).toBe('{{ $env.API_KEY }}');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ options: expect.objectContaining({ apiKey: '{{ $env.API_KEY }}' }) }),
      );
    });
    expect(apiClientRequest).toHaveBeenCalledWith({
      url: 'environmentVariables?paginate=false',
      skipNotify: true,
    });
    expect(screen.queryByDisplayValue(/secret value/i)).not.toBeInTheDocument();
  });

  it('preserves a saved env reference when another option is changed', async () => {
    const onFinish = vi.fn();
    renderSettings({ apiKey: '{{ $env.API_KEY }}', disableStream: false }, onFinish);

    expect(screen.getByDisplayValue('{{ $env.API_KEY }}')).toBeInTheDocument();
    expect(apiClientRequest).not.toHaveBeenCalled();
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

  it('keeps a literal API key masked and preserves it on save', async () => {
    const onFinish = vi.fn();
    renderSettings({ apiKey: 'local-test-key' }, onFinish);

    const input = screen.getByDisplayValue('local-test-key');
    expect(input).toHaveAttribute('type', 'password');
    openEnvSelect();
    expect(await findEnvOption('API_KEY')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('secret-test-value')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ options: expect.objectContaining({ apiKey: 'local-test-key' }) }),
      );
    });
  });

  it('keeps the literal when loading fails and retries when the picker is reopened', async () => {
    apiClientRequest
      .mockRejectedValueOnce(new Error('request failed'))
      .mockResolvedValueOnce({ data: { data: [{ name: 'API_KEY', type: 'secret' }] } });
    const formRef = React.createRef<FormInstance>();
    render(
      <Form ref={formRef} initialValues={{ options: { apiKey: 'local-test-key' } }}>
        <ReopenableProviderSettings />
      </Form>,
    );

    openEnvSelect();
    expect(await screen.findByText('Unable to load environment variables')).toBeInTheDocument();
    expect(formRef.current?.getFieldValue(['options', 'apiKey'])).toBe('local-test-key');

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen settings' }));
    openEnvSelect();
    expect(await findEnvOption('API_KEY')).toBeInTheDocument();
    expect(apiClientRequest).toHaveBeenCalledTimes(2);
    expect(formRef.current?.getFieldValue(['options', 'apiKey'])).toBe('local-test-key');
  });

  it('allows clearing an env reference and entering a literal key again', async () => {
    const onFinish = vi.fn();
    renderSettings({}, onFinish);

    openEnvSelect();
    fireEvent.click(await findEnvOption('API_KEY'));
    expect(screen.getByDisplayValue('{{ $env.API_KEY }}')).toBeInTheDocument();
    expect(screen.queryByText('API_KEY', { selector: '.ant-select-selection-item' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear API key' }));
    expect(screen.queryByText('API_KEY', { selector: '.ant-select-selection-item' })).not.toBeInTheDocument();
    const input = screen.getByLabelText('API Key');
    fireEvent.change(input, { target: { value: 'new-literal-key' } });
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ options: expect.objectContaining({ apiKey: 'new-literal-key' }) }),
      );
    });
  });
});
