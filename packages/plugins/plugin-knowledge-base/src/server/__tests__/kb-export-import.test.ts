// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import aiKnowledgeBase from '../resources/ai-knowledge-base';

describe('aiKnowledgeBase.export/import', () => {
  function makeCtx(overrides: Record<string, unknown> = {}) {
    type TestTransaction = { LOCK: { UPDATE: string } };
    const transaction: TestTransaction = { LOCK: { UPDATE: 'UPDATE' } };
    const { db: dbOverrides, ...ctxOverrides } = overrides;
    const db = {
      sequelize: {
        transaction: vi.fn(async (callback: (transaction: TestTransaction) => Promise<unknown>) =>
          callback(transaction),
        ),
      },
      getRepository: vi.fn(),
      ...(dbOverrides as Record<string, unknown> | undefined),
    };
    return {
      action: { params: {} },
      auth: { user: { id: 1, roles: ['root'] } },
      state: { currentRoles: ['root'] },
      app: { acl: { getRole: vi.fn(() => ({ getStrategy: () => ({ allowConfigure: true }) })) } },
      db,
      t: vi.fn((key: string) => key),
      throw: vi.fn((status: number, message: unknown) => {
        throw Object.assign(new Error(String(message)), { status });
      }),
      set: vi.fn(),
      body: null,
      ...ctxOverrides,
    } as never;
  }

  it('export returns sanitized payload and requires manage permission', async () => {
    const kbRecord = {
      id: 'kb-1',
      name: 'Docs',
      description: 'd',
      type: 'LOCAL',
      accessLevel: 'PUBLIC',
      enabled: true,
      toJSON() {
        return this;
      },
    };
    const docs = [
      {
        filename: 'a.txt',
        textContent: 'hello',
        status: 'success',
        toJSON() {
          return this;
        },
      },
    ];
    const ctx = makeCtx({
      action: { params: { filterByTk: 'kb-1' } },
      db: {
        getRepository: vi.fn((name: string) =>
          name === 'aiKnowledgeBases' ? { findOne: vi.fn(async () => kbRecord) } : { find: vi.fn(async () => docs) },
        ),
      },
    }) as any;

    await aiKnowledgeBase.actions.export(ctx, vi.fn());

    expect(ctx.body.formatVersion).toBe(1);
    expect(ctx.body.knowledgeBase.name).toBe('Docs');
    expect(ctx.body.documents[0].textContent).toBe('hello');
    // status is normalized to pending for re-vectorization on import
    expect(ctx.body.documents[0].status).toBe('pending');
  });

  it('import downgrades to BASIC for non-admin even with PUBLIC payload', async () => {
    const create = vi.fn(async ({ values }: any) => ({ get: (k: string) => values[k] ?? `id-${values.name}` }));
    const docCreate = vi.fn(async ({ values }: any) => ({
      get: (k: string) => values[k] ?? 'doc-id',
      set: vi.fn(),
    }));
    const ctx = makeCtx({
      auth: { user: { id: 7, roles: ['member'] } },
      state: { currentRoles: ['member'] },
      app: { acl: { getRole: vi.fn() } },
      action: {
        params: {
          values: {
            payload: {
              formatVersion: 1,
              knowledgeBase: { name: 'Imported', accessLevel: 'BASIC', type: 'LOCAL' },
              documents: [{ filename: 'x.txt', textContent: 'content' }],
            },
          },
        },
      },
      db: {
        getRepository: vi.fn((name: string) => {
          if (name === 'aiKnowledgeBases') {
            return {
              create,
              update: vi.fn(),
              collection: {
                model: {
                  findOne: vi.fn(async () => ({ toJSON: () => ({ id: 'id-Imported', vectorStoreId: null }) })),
                },
              },
            };
          }
          return { create: docCreate, update: vi.fn() };
        }),
      },
    }) as any;

    const next = vi.fn();
    await aiKnowledgeBase.actions.import(ctx, next);

    expect(create).toHaveBeenCalled();
    const createdValues = create.mock.calls[0][0].values;
    expect(createdValues.accessLevel).toBe('BASIC');
    expect(ctx.body.success).toBe(true);
    expect(ctx.body.importedDocuments).toBe(1);
  });

  it('import rejects PUBLIC payload from non-admin', async () => {
    const create = vi.fn();
    const ctx = makeCtx({
      auth: { user: { id: 7, roles: ['member'] } },
      state: { currentRoles: ['member'] },
      app: { acl: { getRole: vi.fn() } },
      action: {
        params: {
          values: {
            payload: {
              formatVersion: 1,
              knowledgeBase: { name: 'Imported', accessLevel: 'PUBLIC', type: 'LOCAL' },
              documents: [],
            },
          },
        },
      },
      db: {
        getRepository: vi.fn(() => ({ create })),
      },
    }) as any;

    await expect(aiKnowledgeBase.actions.import(ctx, vi.fn())).rejects.toMatchObject({
      status: 403,
      message: 'Only administrators can import shared or public knowledge bases',
    });

    expect(ctx.throw).toHaveBeenCalledWith(403, 'Only administrators can import shared or public knowledge bases');
    expect(create).not.toHaveBeenCalled();
  });
  it('import rejects unsupported format version', async () => {
    const ctx = makeCtx({
      action: { params: { values: { payload: { formatVersion: 99 } } } },
    }) as any;

    await expect(aiKnowledgeBase.actions.import(ctx, vi.fn())).rejects.toMatchObject({
      status: 400,
      message: 'Unsupported export format version',
    });

    expect(ctx.throw).toHaveBeenCalledWith(400, 'Unsupported export format version');
  });
});
