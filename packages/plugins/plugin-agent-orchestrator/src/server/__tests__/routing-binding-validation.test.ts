/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';
import { describe, expect, it, vi } from 'vitest';
import {
  routingBindingError,
  routingWouldCycle,
  validateRoutingBindingAction,
} from '../services/RoutingBindingValidation';

const validBinding = {
  leaderUsername: 'orchestrator',
  subAgentUsername: 'specialist',
  routingEnabled: true,
  routingRole: 'specialist',
  llmService: 'fast',
  model: 'lite-model',
};

function createContext(
  options: {
    actionName?: string;
    resourceName?: string;
    values?: Record<string, unknown> | Array<Record<string, unknown>>;
    filterByTk?: unknown;
    stored?: Record<string, unknown> | null;
    affected?: Record<string, unknown> | null;
    rows?: Array<Record<string, unknown>>;
  } = {},
) {
  const thrown = new Error('ctx.throw');
  const repository = {
    findOne: vi.fn(async (query?: { filterByTk?: unknown; filter?: unknown }) =>
      query?.filterByTk != null ? options.stored ?? validBinding : options.affected ?? null,
    ),
    find: vi.fn(async () => options.rows ?? []),
  };
  const getRepository = vi.fn(() => repository);
  const ctx = {
    action: {
      resourceName: options.resourceName ?? 'orchestratorConfig',
      actionName: options.actionName ?? 'create',
      params: {
        values: options.values ?? { ...validBinding },
        filterByTk: options.filterByTk,
      },
    },
    db: {
      getRepository,
    },
    t: (message: string) => message,
    throw: vi.fn((_status: number, _message: string) => {
      throw thrown;
    }),
  };
  return { ctx: ctx as unknown as Context, thrown, repository: getRepository, repositoryActions: repository };
}

describe('routing binding validation', () => {
  it('requires a distinct parent, a supported target role, and a complete optional model pair', () => {
    expect(routingBindingError({ ...validBinding, subAgentUsername: 'orchestrator' })).toContain(
      'cannot delegate to itself',
    );
    expect(routingBindingError({ ...validBinding, routingRole: 'worker-2' })).toContain('routing role');
    expect(routingBindingError({ ...validBinding, llmService: '' })).toContain('both an LLM service and a model');
    expect(routingBindingError({ ...validBinding, routingPrompt: 'x'.repeat(4001) })).toContain('4000');
  });

  it('keeps legacy and explicitly disabled bindings valid', () => {
    expect(routingBindingError({ leaderUsername: 'legacy', subAgentUsername: 'legacy' })).toBeNull();
    expect(
      routingBindingError({
        ...validBinding,
        routingEnabled: false,
        routingRole: undefined,
        llmService: 'service-without-model',
        model: undefined,
      }),
    ).toBeNull();
  });

  it('validates a partial update against the stored binding', async () => {
    const { ctx, repository } = createContext({
      actionName: 'update',
      filterByTk: 12,
      values: { routingEnabled: true },
      stored: { ...validBinding, routingEnabled: false },
    });
    const next = vi.fn(async () => undefined);

    await validateRoutingBindingAction(ctx, next);

    expect(repository).toHaveBeenCalledWith('orchestratorConfig');
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects a partial model update that leaves an incomplete model pair', async () => {
    const { ctx, thrown } = createContext({
      actionName: 'update',
      filterByTk: 12,
      values: { model: '' },
      stored: validBinding,
    });
    const next = vi.fn(async () => undefined);

    await expect(validateRoutingBindingAction(ctx, next)).rejects.toBe(thrown);

    expect(ctx.throw).toHaveBeenCalledWith(400, 'Select both an LLM service and a model, or leave both empty.');
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects routing updates without a single binding key', async () => {
    const { ctx, thrown } = createContext({ actionName: 'update', values: { routingEnabled: true } });

    await expect(
      validateRoutingBindingAction(
        ctx,
        vi.fn(async () => undefined),
      ),
    ).rejects.toBe(thrown);
    expect(ctx.throw).toHaveBeenCalledWith(400, 'Update routing settings for one binding at a time.');
  });

  it('lets unrelated resources and non-routing batch updates continue', async () => {
    const unrelated = createContext({ resourceName: 'agentGovernancePolicies' });
    const unrelatedNext = vi.fn(async () => undefined);
    await validateRoutingBindingAction(unrelated.ctx, unrelatedNext);
    expect(unrelatedNext).toHaveBeenCalledOnce();

    const unrelatedPatch = createContext({ actionName: 'update', values: { timeout: 5000 } });
    const patchNext = vi.fn(async () => undefined);
    await validateRoutingBindingAction(unrelatedPatch.ctx, patchNext);
    expect(unrelatedPatch.repository).not.toHaveBeenCalled();
    expect(patchNext).toHaveBeenCalledOnce();
  });

  it('rejects a non-boolean enabled value', async () => {
    const { ctx, thrown } = createContext({ values: { ...validBinding, routingEnabled: 'true' } });

    await expect(
      validateRoutingBindingAction(
        ctx,
        vi.fn(async () => undefined),
      ),
    ).rejects.toBe(thrown);
    expect(ctx.throw).toHaveBeenCalledWith(400, 'Routing enabled must be a boolean.');
  });

  it('rejects a cycle in the enabled routing graph', async () => {
    const { ctx, thrown } = createContext({
      values: { ...validBinding, leaderUsername: 'specialist', subAgentUsername: 'orchestrator' },
      rows: [
        { id: 1, leaderUsername: 'orchestrator', subAgentUsername: 'specialist', enabled: true, routingEnabled: true },
      ],
    });

    await expect(
      validateRoutingBindingAction(
        ctx,
        vi.fn(async () => undefined),
      ),
    ).rejects.toBe(thrown);
    expect(ctx.throw).toHaveBeenCalledWith(400, 'This binding would create a delegation cycle.');
    expect(
      routingWouldCycle({ ...validBinding, leaderUsername: 'specialist', subAgentUsername: 'orchestrator' }, [
        { leaderUsername: 'orchestrator', subAgentUsername: 'specialist', enabled: true, routingEnabled: true },
      ]),
    ).toBe(true);
  });

  it('rejects batch identity changes that could retarget active routing records', async () => {
    const { ctx, thrown, repositoryActions } = createContext({
      actionName: 'update',
      values: { leaderUsername: 'another-orchestrator' },
      affected: { id: 12 },
    });

    await expect(
      validateRoutingBindingAction(
        ctx,
        vi.fn(async () => undefined),
      ),
    ).rejects.toBe(thrown);
    expect(repositoryActions.findOne).toHaveBeenCalledWith({
      filter: { $and: [{}, {}, { routingEnabled: true }] },
    });
    expect(ctx.throw).toHaveBeenCalledWith(400, 'Update routing settings for one binding at a time.');
  });

  it('rejects multi-row changes to routing fields while allowing unrelated batch updates', async () => {
    const { ctx, thrown } = createContext({
      actionName: 'update',
      values: [{ routingEnabled: false }],
    });
    await expect(
      validateRoutingBindingAction(
        ctx,
        vi.fn(async () => undefined),
      ),
    ).rejects.toBe(thrown);
    expect(ctx.throw).toHaveBeenCalledWith(400, 'Update routing settings for one binding at a time.');

    const unrelated = createContext({ actionName: 'update', values: [{ timeout: 1000 }] });
    const next = vi.fn(async () => undefined);
    await validateRoutingBindingAction(unrelated.ctx, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects mixed managed binding identity batches but allows legacy-only batches', async () => {
    const mixedBatch = createContext({
      actionName: 'update',
      filterByTk: [1, 2],
      values: { leaderUsername: 'renamed-parent' },
      affected: { id: 2, routingEnabled: true },
    });
    const mixedNext = vi.fn(async () => undefined);
    await expect(validateRoutingBindingAction(mixedBatch.ctx, mixedNext)).rejects.toBe(mixedBatch.thrown);
    expect(mixedBatch.ctx.throw).toHaveBeenCalledWith(400, 'Update routing settings for one binding at a time.');
    expect(mixedBatch.repositoryActions.findOne).toHaveBeenCalledWith({
      filter: { $and: [{}, { id: [1, 2] }, { routingEnabled: true }] },
    });
    expect(mixedNext).not.toHaveBeenCalled();

    const legacyOnlyBatch = createContext({
      actionName: 'update',
      filterByTk: [1, 2],
      values: { leaderUsername: 'renamed-parent' },
      affected: null,
    });
    const legacyNext = vi.fn(async () => undefined);
    await validateRoutingBindingAction(legacyOnlyBatch.ctx, legacyNext);
    expect(legacyNext).toHaveBeenCalledOnce();

    const routingFieldsBatch = createContext({
      actionName: 'update',
      filterByTk: [1, 2],
      values: { routingRole: 'worker' },
    });
    const routingFieldsNext = vi.fn(async () => undefined);
    await expect(validateRoutingBindingAction(routingFieldsBatch.ctx, routingFieldsNext)).rejects.toBe(
      routingFieldsBatch.thrown,
    );
    expect(routingFieldsBatch.ctx.throw).toHaveBeenCalledWith(
      400,
      'Update routing settings for one binding at a time.',
    );
    expect(routingFieldsNext).not.toHaveBeenCalled();
  });
});
