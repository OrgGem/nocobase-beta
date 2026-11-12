// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import documentsResource from '../resources/ai-knowledge-base-documents';

function createContext() {
  const ctx = {
    action: { params: { values: { knowledgeBaseId: 'kb-1' } } },
    t: (key: string) => key,
    throw: vi.fn((status: number, message: string) => {
      throw Object.assign(new Error(message), { status });
    }),
  };
  return ctx;
}

describe('aiKnowledgeBaseDoc resource', () => {
  it('exposes bulkDestroy and bulkReprocess as public resource actions', () => {
    expect(documentsResource.actions.bulkDestroy).toEqual(expect.any(Function));
    expect(documentsResource.actions.bulkReprocess).toEqual(expect.any(Function));
  });

  it('bulkDestroy rejects when documentIds is missing', async () => {
    const ctx = createContext();

    await expect(documentsResource.actions.bulkDestroy(ctx as never, vi.fn())).rejects.toMatchObject({
      status: 400,
      message: 'documentIds is required',
    });

    expect(ctx.throw).toHaveBeenCalledWith(400, 'documentIds is required');
  });

  it('bulkReprocess rejects when documentIds is missing', async () => {
    const ctx = createContext();

    await expect(documentsResource.actions.bulkReprocess(ctx as never, vi.fn())).rejects.toMatchObject({
      status: 400,
      message: 'documentIds is required',
    });

    expect(ctx.throw).toHaveBeenCalledWith(400, 'documentIds is required');
  });
});
