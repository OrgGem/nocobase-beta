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
import { buildModelObject, handleGetModel, handleListModels } from '../routes/models';

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
