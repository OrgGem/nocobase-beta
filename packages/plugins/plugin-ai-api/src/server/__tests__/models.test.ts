/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import { buildModelObject } from '../routes/models';

const CREATED = 1_700_000_000;

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
