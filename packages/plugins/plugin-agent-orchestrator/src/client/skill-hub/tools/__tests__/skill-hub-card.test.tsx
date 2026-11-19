/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as ClientV2 from '@nocobase/client-v2';
import { AxiosHeaders } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InteractionSchemasProvider } from '../InteractionSchemasProvider';
import { registerSkillLoopCards } from '../registerSkillLoopCards';
import { SkillHubCard } from '../SkillHubCard';

const skillDefinitions = [
  {
    id: 1,
    name: 'Renamed & Skill',
    toolName: 'skill_hub_original_identity',
    autoCall: true,
    interactionSchema: {
      type: 'select',
      prompt: 'Choose native input',
      options: [
        { label: 'Native old', value: 'old' },
        { label: 'Native new', value: 'new' },
      ],
    },
  },
  {
    id: 2,
    name: 'Legacy Skill',
    autoCall: true,
    interactionSchema: {
      type: 'select',
      prompt: 'Choose generic input',
      options: [
        { label: 'Generic old', value: 'old' },
        { label: 'Generic new', value: 'new' },
      ],
    },
  },
];

function cardProps(
  name: string,
  args: Record<string, unknown>,
  edit: ReturnType<typeof vi.fn>,
): React.ComponentProps<typeof SkillHubCard> {
  return {
    messageId: 'message-1',
    tools: {} as React.ComponentProps<typeof SkillHubCard>['tools'],
    toolCall: {
      id: name,
      type: 'function',
      name,
      invokeStatus: 'interrupted',
      auto: false,
      args,
    },
    decisions: {
      approve: vi.fn(async () => {}),
      edit,
      reject: vi.fn(async () => {}),
    },
  };
}

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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('v1 Skill Hub card interactions', () => {
  it('preserves native and generic inputs when a select schema edits the choice', async () => {
    const app = ClientV2.createMockClient();
    app.apiClient.auth.setToken('test-token');
    let loopConfigs: Array<{ skillId: string | number; schema?: unknown; prompt?: string }> = [];
    const request = vi.spyOn(app.apiClient, 'request').mockImplementation(async (config) => {
      const url = 'url' in config ? config.url : undefined;
      return {
        data: {
          data: url === 'skillDefinitions:list' ? skillDefinitions : url === 'skillLoopConfigs:list' ? loopConfigs : [],
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: { headers: new AxiosHeaders() },
      };
    });
    vi.spyOn(ClientV2, 'useApp').mockReturnValue(app);

    const nativeEdit = vi.fn(async (_args: unknown) => {});
    const genericEdit = vi.fn(async (_args: unknown) => {});
    const registerTools = vi.fn();

    await registerSkillLoopCards({
      aiManager: { toolsManager: { registerTools } },
      apiClient: app.apiClient,
    });
    expect(registerTools.mock.calls.map(([name]) => name)).toEqual([
      'skill_hub_execute',
      'skill_hub_original_identity',
      'skill_hub_legacy_skill',
    ]);

    render(
      <InteractionSchemasProvider>
        <div data-testid="native-card">
          <SkillHubCard
            {...cardProps('skill_hub_original_identity', { retained: 'native', choice: 'old' }, nativeEdit)}
          />
        </div>
        <div data-testid="generic-card">
          <SkillHubCard
            {...cardProps(
              'skill_hub_execute',
              { action: 'execute', skillName: 'Renamed & Skill', input: { retained: 'generic', choice: 'old' } },
              genericEdit,
            )}
          />
        </div>
        <div data-testid="loop-b-card">
          <SkillHubCard
            {...cardProps(
              'skill_hub_legacy_skill',
              {},
              vi.fn(async (_args: unknown) => {}),
            )}
          />
        </div>
      </InteractionSchemasProvider>,
    );

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'skillDefinitions:list',
        params: expect.objectContaining({ fields: expect.arrayContaining(['toolName', 'autoCall']) }),
      }),
    );
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(6));
    const nativeCardNode = screen.getByTestId('native-card');
    const genericCardNode = screen.getByTestId('generic-card');
    const loopBCardNode = screen.getByTestId('loop-b-card');
    const nativeCard = within(nativeCardNode);
    const genericCard = within(genericCardNode);
    expect(nativeCardNode.textContent).toContain('Choose native input');
    expect(genericCardNode.textContent).toContain('Choose native input');

    fireEvent.click(nativeCard.getByRole('radio', { name: 'Native new' }));
    fireEvent.click(genericCard.getByRole('radio', { name: 'Native new' }));
    fireEvent.click(nativeCard.getByRole('button', { name: 'Run' }));
    fireEvent.click(genericCard.getByRole('button', { name: 'Run' }));

    await waitFor(() => {
      expect(nativeEdit).toHaveBeenCalledWith({ retained: 'native', choice: 'new' });
      expect(genericEdit).toHaveBeenCalledWith({
        action: 'execute',
        skillName: 'Renamed & Skill',
        input: { retained: 'generic', choice: 'new' },
      });
    });

    nativeEdit.mockClear();
    genericEdit.mockClear();
    loopConfigs = [
      {
        skillId: 1,
        schema: {
          type: 'select',
          prompt: 'Updated A loop schema',
          options: [{ label: 'A updated choice', value: 'a-updated' }],
        },
      },
      { skillId: 2, schema: { type: 'confirm', prompt: 'B2 loop schema' } },
      {
        skillId: 1,
        schema: {
          type: 'select',
          prompt: 'Older A1 loop schema',
          options: [{ label: 'A1 older choice', value: 'a1-older' }],
        },
      },
    ];
    act(() => {
      window.dispatchEvent(new Event('skill-hub-loop-settings-changed'));
    });

    await waitFor(() => {
      expect(nativeCardNode.textContent).toContain('Updated A loop schema');
      expect(nativeCardNode.textContent).not.toContain('Older A1 loop schema');
      expect(loopBCardNode.textContent).toContain('B2 loop schema');
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'skillLoopConfigs:list',
        params: expect.objectContaining({ sort: ['-updatedAt'] }),
      }),
    );

    fireEvent.click(nativeCard.getByRole('radio', { name: 'A updated choice' }));
    fireEvent.click(genericCard.getByRole('radio', { name: 'A updated choice' }));
    fireEvent.click(nativeCard.getByRole('button', { name: 'Run' }));
    fireEvent.click(genericCard.getByRole('button', { name: 'Run' }));
    await waitFor(() => {
      expect(nativeEdit).toHaveBeenCalledWith({ retained: 'native', choice: 'a-updated' });
      expect(genericEdit).toHaveBeenCalledWith({
        action: 'execute',
        skillName: 'Renamed & Skill',
        input: { retained: 'generic', choice: 'a-updated' },
      });
    });

    loopConfigs = [
      { skillId: 1, schema: '{broken' },
      { skillId: 2, schema: { type: 'confirm', prompt: 'B2 loop schema' } },
      {
        skillId: 1,
        schema: {
          type: 'select',
          prompt: 'Older A1 loop schema',
          options: [{ label: 'A1 older choice', value: 'a1-older' }],
        },
      },
    ];
    act(() => {
      window.dispatchEvent(new Event('skill-hub-loop-settings-changed'));
    });

    await waitFor(() => {
      expect(nativeCardNode.textContent).toContain('Choose native input');
      expect(nativeCardNode.textContent).not.toContain('Older A1 loop schema');
      expect(genericCardNode.textContent).toContain('Choose native input');
      expect(loopBCardNode.textContent).toContain('B2 loop schema');
    });
    expect(nativeCard.getByRole('radio', { name: 'Native old' })).toBeTruthy();
  });
});
