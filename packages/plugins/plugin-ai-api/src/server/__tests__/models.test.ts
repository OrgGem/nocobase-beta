/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import { describe, expect, it, vi } from 'vitest';
import { buildModelObject, buildVirtualModelObject, handleGetModel, handleListModels } from '../routes/models';

const CREATED = 1_700_000_000;

function permissionLookupFailureContext() {
  const ctx = {
    app: { name: 'main', pm: { get: () => ({}) } },
    state: { currentUser: { id: 1 } },
    db: {
      getRepository: (name: string) => {
        if (name === 'aiApiConfig') return { findOne: vi.fn(async () => null) };
        if (name === 'llmServices') return { find: vi.fn(async () => []) };
        if (name === 'aiApiGroupMembers') {
          return { findOne: vi.fn(async () => Promise.reject(new Error('permission database unavailable'))) };
        }
        return { find: vi.fn(async () => []) };
      },
    },
    log: { error: vi.fn(), warn: vi.fn() },
    status: 0,
    body: undefined,
  } as unknown as Context;
  return ctx;
}

interface FixtureRow {
  [key: string]: unknown;
}

/** A model row whose shape matches Sequelize's get(key) accessor (get() with no key returns all). */
function rowOf(data: FixtureRow) {
  return { get: (key?: string) => (key === undefined ? data : data[key]) };
}

/** A service row: plain properties for resolveEnabledModels, get() for permission checks. */
function serviceRow(data: FixtureRow) {
  return { ...data, get: (key?: string) => (key === undefined ? data : data[key]) };
}

/**
 * Build a ctx exposing a given list of models for one enabled service.
 * The caller's scope is the open default group (allowAllModels), so catalog
 * membership is decided only by metadata flags and the service permission filter.
 */
function catalogContext(services: FixtureRow[], metadataRows: FixtureRow[]) {
  const defaultGroup = {
    id: 1,
    name: 'Default',
    isDefault: true,
    enabled: false,
    allowAllModels: true,
    allowedModels: [],
    allowedLlmServices: [],
  };
  const ctx = {
    app: { name: 'main', pm: { get: () => ({}) } },
    state: { currentUser: { id: 1 } },
    db: {
      getRepository: (name: string) => {
        if (name === 'aiApiConfig') return { findOne: vi.fn(async () => null) };
        if (name === 'llmServices') return { find: vi.fn(async () => services.map(serviceRow)) };
        if (name === 'aiApiModelMetadata') return { find: vi.fn(async () => metadataRows.map(rowOf)) };
        if (name === 'aiApiGroupMembers') return { findOne: vi.fn(async () => null) };
        if (name === 'aiApiUsageGroups') return { findOne: vi.fn(async () => rowOf(defaultGroup)) };
        if (name === 'aiApiVirtualModels') return { find: vi.fn(async () => []) };
        return { find: vi.fn(async () => []) };
      },
    },
    log: { error: vi.fn(), warn: vi.fn() },
    status: 0,
    body: undefined,
  } as unknown as Context;
  return ctx;
}

describe('buildModelObject', () => {
  it('returns the base OpenAI model shape with no override', () => {
    const model = buildModelObject('svc/gpt-4o', CREATED, 'My Service');
    expect(model).toEqual({
      id: 'svc/gpt-4o',
      object: 'model',
      created: CREATED,
      owned_by: 'My Service',
    });
    // No override → no context_window / active field is added.
    expect(model).not.toHaveProperty('context_window');
    expect(model).not.toHaveProperty('active');
  });

  it('emits context window under both context_window and context_length', () => {
    const model = buildModelObject('svc/m', CREATED, 'Svc', { contextWindow: 100_000 });
    expect(model.context_window).toBe(100_000);
    expect(model.context_length).toBe(100_000);
  });

  it('overrides owned_by, display name and description', () => {
    const model = buildModelObject('svc/m', CREATED, 'Svc', {
      ownedByOverride: 'Acme',
      displayName: 'Acme Turbo',
      description: 'Fast model',
    });
    expect(model.owned_by).toBe('Acme');
    expect(model.display_name).toBe('Acme Turbo');
    expect(model.name).toBe('Acme Turbo');
    expect(model.description).toBe('Fast model');
  });

  it('falls back to the service label when ownedByOverride is empty', () => {
    const model = buildModelObject('svc/m', CREATED, 'Svc', { ownedByOverride: '' });
    expect(model.owned_by).toBe('Svc');
  });

  it('emits max_completion_tokens only when positive', () => {
    expect(buildModelObject('svc/m', CREATED, 'Svc', { maxCompletionTokens: 4096 }).max_completion_tokens).toBe(4096);
    expect(buildModelObject('svc/m', CREATED, 'Svc', { maxCompletionTokens: 0 })).not.toHaveProperty(
      'max_completion_tokens',
    );
    expect(buildModelObject('svc/m', CREATED, 'Svc', { maxCompletionTokens: null })).not.toHaveProperty(
      'max_completion_tokens',
    );
  });

  it('ignores non-positive or non-integer context windows', () => {
    expect(buildModelObject('svc/m', CREATED, 'Svc', { contextWindow: 0 })).not.toHaveProperty('context_window');
    expect(buildModelObject('svc/m', CREATED, 'Svc', { contextWindow: -5 })).not.toHaveProperty('context_window');
    expect(buildModelObject('svc/m', CREATED, 'Svc', { contextWindow: null })).not.toHaveProperty('context_window');
  });

  it('surfaces active flag whenever an override row exists', () => {
    expect(buildModelObject('svc/m', CREATED, 'Svc', { enabled: true }).active).toBe(true);
    expect(buildModelObject('svc/m', CREATED, 'Svc', { enabled: false }).active).toBe(false);
    // Override present with enabled undefined → treated as active.
    expect(buildModelObject('svc/m', CREATED, 'Svc', { contextWindow: 10 }).active).toBe(true);
  });
});

describe('buildVirtualModelObject', () => {
  it('surfaces the endpoint family of an alias', () => {
    expect(
      buildVirtualModelObject(
        {
          name: 'embed-auto',
          mode: 'embedding',
          fallbackModel: 'openai/text-embedding-3-small',
        },
        CREATED,
      ),
    ).toMatchObject({
      id: 'embed-auto',
      object: 'model',
      virtual: true,
      mode: 'embedding',
    });
  });
});

describe('model catalog permission lookup failures', () => {
  it('returns a retryable 503 when listing models', async () => {
    const ctx = permissionLookupFailureContext();

    await handleListModels(ctx, undefined as never);

    expect(ctx.status).toBe(503);
    expect(ctx.body).toMatchObject({ error: { code: 'permission_check_failed' } });
  });

  it('returns a retryable 503 when retrieving a model', async () => {
    const ctx = permissionLookupFailureContext();

    await handleGetModel(ctx, 'openai/gpt-4o', undefined as never);

    expect(ctx.status).toBe(503);
    expect(ctx.body).toMatchObject({ error: { code: 'permission_check_failed' } });
  });
});

describe('hidden models', () => {
  const services: FixtureRow[] = [
    {
      id: 1,
      name: 'svc',
      title: 'Test Service',
      enabled: true,
      enabledModels: ['visible', 'hidden'],
    },
  ];

  const metadata: FixtureRow[] = [{ llmService: 'svc', model: 'hidden', enabled: true, hidden: true, sortOrder: 0 }];

  it('omits a hidden model from the model list', async () => {
    const ctx = catalogContext(services, metadata);

    await handleListModels(ctx, undefined as never);

    expect(ctx.status).toBe(200);
    const ids = (ctx.body as { data: Array<{ id: string }> }).data.map((model) => model.id);
    expect(ids).toEqual(['svc/visible']);
  });

  it('answers 404 for a hidden model on the single-model endpoint', async () => {
    const ctx = catalogContext(services, metadata);

    await handleGetModel(ctx, 'svc/hidden', undefined as never);

    expect(ctx.status).toBe(404);
    expect(ctx.body).toMatchObject({ error: { code: 'model_not_found' } });
  });

  it('still serves a visible model alongside a hidden one', async () => {
    const ctx = catalogContext(services, metadata);

    await handleGetModel(ctx, 'svc/visible', undefined as never);

    expect(ctx.status).toBe(200);
    expect(ctx.body).toMatchObject({ id: 'svc/visible' });
  });

  it('keeps models without an override row visible', async () => {
    const ctx = catalogContext(services, []);

    await handleListModels(ctx, undefined as never);

    const ids = (ctx.body as { data: Array<{ id: string }> }).data.map((model) => model.id);
    expect(ids).toEqual(['svc/visible', 'svc/hidden']);
  });
});

describe('hidden models stay routable via virtual aliases', () => {
  it('resolves a virtual alias to a hidden model selected by a routing rule', async () => {
    const defaultGroup = {
      id: 1,
      name: 'Default',
      isDefault: true,
      enabled: false,
      allowAllModels: true,
      allowedModels: [],
      allowedLlmServices: [],
    };
    const ctx = {
      app: { name: 'hidden-routing', pm: { get: () => ({}) } },
      state: { currentUser: { id: 1 } },
      db: {
        getRepository: (name: string) => {
          if (name === 'aiApiConfig') return { findOne: vi.fn(async () => null) };
          if (name === 'aiApiVirtualModels') {
            return {
              findOne: vi.fn(async () =>
                rowOf({
                  name: 'auto',
                  mode: 'chat',
                  fallbackModel: 'svc/hidden',
                  cheapModels: ['svc/hidden'],
                  enabled: true,
                }),
              ),
            };
          }
          if (name === 'llmServices') {
            return {
              findOne: vi.fn(async () =>
                rowOf({ name: 'svc', title: 'Test Service', enabled: true, provider: 'openai' }),
              ),
              find: vi.fn(async () => []),
            };
          }
          if (name === 'aiApiModelMetadata') {
            return {
              find: vi.fn(async () => []),
              findOne: vi.fn(async () => rowOf({ enabled: true, hidden: true })),
            };
          }
          if (name === 'aiApiGroupMembers') return { findOne: vi.fn(async () => null) };
          if (name === 'aiApiUsageGroups') return { findOne: vi.fn(async () => rowOf(defaultGroup)) };
          return { find: vi.fn(async () => []) };
        },
      },
      log: { error: vi.fn(), warn: vi.fn() },
      status: 0,
      body: undefined,
    } as unknown as Context;

    const { resolveVirtualModel } = await import('../utils/virtual-models');
    const result = await resolveVirtualModel(ctx, 'auto', { messages: [{ role: 'user', content: 'hi' }] }, 'chat');

    expect(result).toMatchObject({
      status: 'resolved',
      resolved: expect.objectContaining({ modelId: 'hidden' }),
    });
  });
});
