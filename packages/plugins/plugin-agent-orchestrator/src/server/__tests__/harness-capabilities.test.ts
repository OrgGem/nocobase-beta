/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Plugin } from '@nocobase/server';
import { getHarnessCapabilities } from '../services/HarnessCapabilities';
import { registerAgentHarnessProfileResource } from '../resources/agent-harness-profile';

type CapabilityAction = (ctx: { body?: unknown }, next: () => Promise<void>) => Promise<void>;

describe('Harness capabilities', () => {
  it('reports native policy support separately for chat, API, workflow, and sub-agent flows', () => {
    const capabilities = getHarnessCapabilities();

    expect(capabilities.scopes).toEqual(['chat', 'api', 'workflow', 'sub-agent']);
    expect(capabilities.nativeCapabilities.map(({ id }) => id)).toEqual([
      'tool-access',
      'runtime-limits',
      'delegation',
      'memory-context',
      'isolation',
      'flow-monitoring',
    ]);

    for (const capability of capabilities.nativeCapabilities) {
      for (const scope of capabilities.scopes) {
        expect(capability.byScope[scope].reasonKey).toBeTruthy();
        expect(capability.byScope[scope].status).toBe(
          capability.id === 'flow-monitoring' ? 'observe-only' : 'unsupported',
        );
      }
    }
  });

  it('documents the scoped Skill Hub sandbox capabilities', () => {
    const capabilities = getHarnessCapabilities();

    expect(capabilities.scopedCapabilities).toEqual([
      expect.objectContaining({
        id: 'skill-hub-timeout',
        status: 'enforced',
        settings: ['tools.timeouts[skill tool]', 'tools.timeouts.skill_hub_execute'],
        scopeKey: 'Skill Hub sandbox execution',
      }),
      expect.objectContaining({
        id: 'skill-hub-output-spill',
        status: 'observe-only',
        settings: ['context.spill.maxInlineBytes'],
        scopeKey: 'Skill Hub sandbox execution',
      }),
    ]);
  });

  it('describes capture, redaction, sharing, and retention as telemetry-local settings', () => {
    const capabilities = getHarnessCapabilities();

    expect(capabilities.telemetrySettings.settings).toEqual([
      'observability.enabled',
      'observability.captureInputs',
      'observability.captureOutputs',
      'observability.redactSecrets',
      'observability.sharing',
      'observability.tracingRetentionDays',
    ]);
    expect(capabilities.telemetrySettings.noteKey).toBe('Harness capability: telemetry settings scope');
  });

  it('exposes the capability matrix through the existing profile resource', async () => {
    const registerResource = vi.fn((definition: { actions: Record<string, CapabilityAction> }) => definition);
    const plugin = {
      app: {
        resource: registerResource,
      },
      db: {},
    } as unknown as Plugin;
    registerAgentHarnessProfileResource(plugin);

    const resource = registerResource.mock.calls[0]?.[0];
    if (!resource) throw new Error('Harness profile resource was not registered.');
    const ctx: { body?: unknown } = {};
    let nextCalled = false;
    await resource.actions.capabilities(ctx, async () => {
      nextCalled = true;
    });

    expect(ctx.body).toEqual({ data: getHarnessCapabilities() });
    expect(nextCalled).toBe(true);
  });
});
