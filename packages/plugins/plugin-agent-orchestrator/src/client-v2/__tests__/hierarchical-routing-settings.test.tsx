// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import * as ClientV2 from '@nocobase/client-v2';
import { AxiosHeaders } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentBindingsTab } from '../components/AgentBindingsTab';
import { AIEmployeesProvider } from '../components/AIEmployeesContext';
import { HarnessSettingsForm } from '../components/HarnessSettingsForm';

const profileSettings = {
  routing: {
    models: {
      primary: { llmService: 'openai', model: 'gpt-strong' },
      fallback: [
        { llmService: 'openai', model: 'gpt-lite' },
        { llmService: 'openai', model: 'gpt-mini' },
      ],
    },
  },
  tools: { allow: ['read_file'], effects: { read_file: 'read' } },
};

const specialistBinding = {
  id: 7,
  leaderUsername: 'orchestrator',
  subAgentUsername: 'researcher',
  harnessTag: 'research',
  enabled: true,
  routingEnabled: true,
  routingRole: 'specialist' as const,
  routingPrompt: 'Research facts and return sources.',
  llmService: null,
  model: null,
};

const workerBinding = {
  ...specialistBinding,
  leaderUsername: 'specialist',
  subAgentUsername: 'worker',
  harnessTag: 'worker-policy',
  routingRole: 'worker' as const,
};

function response(data: unknown) {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
}

function useTestApp() {
  const app = ClientV2.createMockClient();
  const request = vi.spyOn(app.apiClient, 'request').mockImplementation(async (config) => {
    const url = 'url' in config ? config.url : undefined;
    if (url === 'ai:listAllEnabledModels') {
      return response({
        data: [
          {
            llmService: 'openai',
            llmServiceTitle: 'OpenAI',
            enabledModels: [
              { value: 'gpt-strong', label: 'Strong' },
              { value: 'gpt-lite', label: 'Lite' },
              { value: 'gpt-mini', label: 'Mini' },
            ],
          },
        ],
        meta: { count: 1 },
      });
    }
    if (url === 'orchestratorConfig:list') {
      return response({ data: [specialistBinding], meta: { count: 1 } });
    }
    if (url === 'agentHarnessProfiles:list') {
      return response({ data: [{ tag: 'research', title: 'Research', enabled: true }], meta: { count: 1 } });
    }
    if (url === 'aiEmployees:list') {
      return response({
        data: [
          { username: 'orchestrator', nickname: 'Orchestrator' },
          { username: 'researcher', nickname: 'Researcher' },
        ],
        meta: { count: 2 },
      });
    }
    return response({ data: [], meta: { count: 0 } });
  });
  vi.spyOn(ClientV2, 'useApp').mockReturnValue(app);
  return { app, request };
}

function ControlledHarnessForm() {
  const [value, setValue] = useState(JSON.stringify(profileSettings));
  return (
    <>
      <HarnessSettingsForm value={value} onChange={setValue} />
      <output data-testid="settings-value">{value}</output>
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({
    matches: false,
    media,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
});

describe('hierarchical routing settings UI', () => {
  it('shows fallback order and persists a reorder without dropping primary model or tool policy', async () => {
    const { request } = useTestApp();
    const view = render(<ControlledHarnessForm />);

    const moveUpButtons = () =>
      Array.from(view.container.querySelectorAll('button')).filter(
        (button) => button.textContent?.trim() === 'Move up',
      );
    await waitFor(() => expect(moveUpButtons()).toHaveLength(2));
    const moveMiniUp = moveUpButtons().find((button) => !button.disabled);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ url: 'ai:listAllEnabledModels' }));
    if (!moveMiniUp) throw new Error('Expected an enabled fallback reorder button');
    fireEvent.click(moveMiniUp);

    await waitFor(() => {
      const updated = JSON.parse(view.getByTestId('settings-value').textContent || '{}');
      expect(updated.routing.models.fallback).toEqual([
        { llmService: 'openai', model: 'gpt-mini' },
        { llmService: 'openai', model: 'gpt-lite' },
      ]);
      expect(updated.routing.models.primary).toEqual({ llmService: 'openai', model: 'gpt-strong' });
      expect(updated.tools).toEqual(profileSettings.tools);
    });
  });

  it('previews the saved specialist binding using the user-owned session and displays fallback selection', async () => {
    const { request } = useTestApp();
    request.mockImplementation(async (config) => {
      const url = 'url' in config ? config.url : undefined;
      if (url === 'agentHierarchy:preview') {
        return response({
          data: {
            data: {
              username: 'researcher',
              role: 'specialist',
              model: { llmService: 'openai', model: 'gpt-lite' },
              fallback: true,
              profile: { tag: 'research', version: 3 },
            },
          },
        });
      }
      if (url === 'orchestratorConfig:list') {
        return response({ data: [specialistBinding], meta: { count: 1 } });
      }
      if (url === 'agentHarnessProfiles:list') {
        return response({ data: [{ tag: 'research', title: 'Research', enabled: true }], meta: { count: 1 } });
      }
      if (url === 'aiEmployees:list') {
        return response({ data: [{ username: 'researcher', nickname: 'Researcher' }], meta: { count: 1 } });
      }
      if (url === 'ai:listAllEnabledModels') {
        return response({ data: [], meta: { count: 0 } });
      }
      return response({ data: [], meta: { count: 0 } });
    });

    const view = render(
      <AIEmployeesProvider>
        <AgentBindingsTab />
      </AIEmployeesProvider>,
    );
    await waitFor(() => expect(view.container.querySelector('tr[data-row-key="7"]')).toBeTruthy());
    const editButton = Array.from(view.container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Edit',
    );
    expect(editButton).toBeTruthy();
    if (!editButton) throw new Error('Expected the saved binding edit button');
    fireEvent.click(editButton);
    await waitFor(() => expect(document.body.querySelector('input[aria-label="Conversation ID"]')).toBeTruthy());
    fireEvent.change(document.body.querySelector('input[aria-label="Conversation ID"]'), {
      target: { value: 'session-123' },
    });
    const previewButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Preview effective routing',
    );
    expect(previewButton).toBeTruthy();
    if (!previewButton) throw new Error('Expected the routing preview button');
    fireEvent.click(previewButton);

    await waitFor(() => expect(document.body.textContent).toContain('gpt-lite'));
    expect(document.body.textContent).toContain('research v3');
    expect(document.body.textContent).toContain('Yes');
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'agentHierarchy:preview',
        method: 'post',
        data: { sessionId: 'session-123', username: 'researcher' },
      }),
    );
  });

  it('previews a worker with its saved specialist and displays both effective model policies', async () => {
    const { request } = useTestApp();
    request.mockImplementation(async (config) => {
      const url = 'url' in config ? config.url : undefined;
      if (url === 'agentHierarchy:preview') {
        return response({
          data: {
            data: {
              username: 'worker',
              role: 'worker',
              model: { llmService: 'openai', model: 'gpt-lite' },
              fallback: true,
              profile: { tag: 'worker-policy', version: 4 },
              specialist: {
                username: 'specialist',
                model: { llmService: 'anthropic', model: 'claude-mid' },
                fallback: false,
                profile: { tag: 'specialist-policy', version: 2 },
              },
            },
          },
        });
      }
      if (url === 'orchestratorConfig:list') {
        return response({ data: [workerBinding], meta: { count: 1 } });
      }
      if (url === 'agentHarnessProfiles:list') {
        return response({
          data: [{ tag: 'worker-policy', title: 'Worker policy', enabled: true }],
          meta: { count: 1 },
        });
      }
      if (url === 'aiEmployees:list') {
        return response({
          data: [
            { username: 'specialist', nickname: 'Specialist agent' },
            { username: 'worker', nickname: 'Worker agent' },
          ],
          meta: { count: 2 },
        });
      }
      return response({ data: [], meta: { count: 0 } });
    });

    const view = render(
      <AIEmployeesProvider>
        <AgentBindingsTab />
      </AIEmployeesProvider>,
    );
    await waitFor(() => expect(view.container.querySelector('tr[data-row-key="7"]')).toBeTruthy());
    const editButton = Array.from(view.container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Edit',
    );
    expect(editButton).toBeTruthy();
    if (!editButton) throw new Error('Expected the saved worker binding edit button');
    fireEvent.click(editButton);
    await waitFor(() => expect(document.body.querySelector('input[aria-label="Conversation ID"]')).toBeTruthy());
    fireEvent.change(document.body.querySelector('input[aria-label="Conversation ID"]'), {
      target: { value: 'worker-session-456' },
    });
    const previewButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Preview effective routing',
    );
    expect(previewButton).toBeTruthy();
    if (!previewButton) throw new Error('Expected the worker routing preview button');
    fireEvent.click(previewButton);

    await waitFor(() => expect(document.body.textContent).toContain('claude-mid'));
    expect(document.body.textContent).toContain('Specialist');
    expect(document.body.textContent).toContain('specialist');
    expect(document.body.textContent).toContain('specialist-policy v2');
    expect(document.body.textContent).toContain('anthropic / claude-mid');
    expect(document.body.textContent).toContain('Worker');
    expect(document.body.textContent).toContain('worker');
    expect(document.body.textContent).toContain('worker-policy v4');
    expect(document.body.textContent).toContain('openai / gpt-lite');
    expect(document.body.textContent).toContain('Yes');
    expect(document.body.textContent).toContain('No');
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'agentHierarchy:preview',
        method: 'post',
        data: {
          sessionId: 'worker-session-456',
          username: 'worker',
          specialistUsername: 'specialist',
        },
      }),
    );
  });

  it('surfaces a permission error when preview is denied and does not display a stale result', async () => {
    const { request } = useTestApp();
    request.mockImplementation(async (config) => {
      const url = 'url' in config ? config.url : undefined;
      if (url === 'agentHierarchy:preview') throw new Error('Permission denied');
      if (url === 'orchestratorConfig:list') return response({ data: [specialistBinding], meta: { count: 1 } });
      if (url === 'agentHarnessProfiles:list') {
        return response({ data: [{ tag: 'research', title: 'Research', enabled: true }], meta: { count: 1 } });
      }
      if (url === 'aiEmployees:list') {
        return response({ data: [{ username: 'researcher', nickname: 'Researcher' }], meta: { count: 1 } });
      }
      return response({ data: [], meta: { count: 0 } });
    });

    const view = render(
      <AIEmployeesProvider>
        <AgentBindingsTab />
      </AIEmployeesProvider>,
    );
    await waitFor(() => expect(view.container.querySelector('tr[data-row-key="7"]')).toBeTruthy());
    const editButton = Array.from(view.container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Edit',
    );
    expect(editButton).toBeTruthy();
    if (!editButton) throw new Error('Expected the saved binding edit button');
    fireEvent.click(editButton);
    await waitFor(() => expect(document.body.querySelector('input[aria-label="Conversation ID"]')).toBeTruthy());
    fireEvent.change(document.body.querySelector('input[aria-label="Conversation ID"]'), {
      target: { value: 'forbidden' },
    });
    const previewButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Preview effective routing',
    );
    expect(previewButton).toBeTruthy();
    if (!previewButton) throw new Error('Expected the routing preview button');
    fireEvent.click(previewButton);

    await waitFor(() => expect(document.body.textContent).toContain('Preview failed: Permission denied'));
    expect(document.body.textContent).not.toContain('Fallback model selected');
  });
});
