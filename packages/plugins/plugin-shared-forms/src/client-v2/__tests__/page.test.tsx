/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import '@testing-library/jest-dom/vitest';
import { FlowEngine, FlowEngineProvider } from '@nocobase/flow-engine';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SharedFormPage from '../SharedFormPage';

vi.mock('../locale', () => ({ useT: () => (key: string) => key }));
vi.mock('../NativeForm', () => ({
  NativeForm: ({ onSubmitted }: { onSubmitted?: () => void }) => (
    <button onClick={onSubmitted}>Submit native form</button>
  ),
}));
vi.mock('@nocobase/client-v2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nocobase/client-v2')>()),
  PoweredBy: () => null,
}));
afterEach(cleanup);
const metadata = (title: string) => ({
  data: {
    data: {
      title,
      collection: 'main:orders',
      config: { version: 2, model: {}, successMessage: 'Thank you' },
      dataSource: { key: 'main', collections: [] },
    },
  },
});
function setup(request: ReturnType<typeof vi.fn>) {
  const eventBus = new EventTarget();
  const engine = new FlowEngine();
  engine.context.defineProperty('app', { value: { apiClient: { request }, eventBus } });
  engine.context.defineProperty('markdown', { value: { render: async (value: string) => <p>{value}</p> } });
  render(
    <FlowEngineProvider engine={engine}>
      <MemoryRouter initialEntries={['/shared-forms/form']}>
        <Routes>
          <Route path="/shared-forms/:name" element={<SharedFormPage />} />
        </Routes>
      </MemoryRouter>
    </FlowEngineProvider>,
  );
  return eventBus;
}
describe('authenticated Shared Forms page with native React/Antd and mocked form/API', () => {
  it('shows the configured success message after submit and can start a fresh response', async () => {
    const request = vi.fn().mockResolvedValue(metadata('Orders'));
    setup(request);
    fireEvent.click(await screen.findByText('Submit native form'));
    expect(await screen.findByText('Thank you')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Submit another response'));
    expect(await screen.findByText('Submit native form')).toBeInTheDocument();
  });
  it('clears the form when a changed role is denied instead of displaying the old authorized form', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(metadata('Orders'))
      .mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { response: { status: 403 } }));
    const events = setup(request);
    expect(await screen.findByText('Submit native form')).toBeInTheDocument();
    act(() => events.dispatchEvent(new Event('auth:roleChanged')));
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Submit native form')).not.toBeInTheDocument());
  });
});
