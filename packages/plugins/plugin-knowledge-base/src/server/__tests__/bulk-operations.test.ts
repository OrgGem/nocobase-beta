import { describe, expect, it, vi } from 'vitest';
import documentsResource from '../resources/ai-knowledge-base-documents';

describe('aiKnowledgeBaseDoc resource', () => {
  it('exposes bulkDestroy and bulkReprocess as public resource actions', () => {
    expect(documentsResource.actions.bulkDestroy).toEqual(expect.any(Function));
    expect(documentsResource.actions.bulkReprocess).toEqual(expect.any(Function));
  });

  it('bulkDestroy rejects when documentIds is missing', async () => {
    const ctx = {
      action: { params: { values: {} } },
      throw: vi.fn(),
    };

    await documentsResource.actions.bulkDestroy(ctx as never, vi.fn());

    expect(ctx.throw).toHaveBeenCalledWith(400, 'documentIds is required');
  });

  it('bulkReprocess rejects when documentIds is missing', async () => {
    const ctx = {
      action: { params: { values: {} } },
      throw: vi.fn(),
    };

    await documentsResource.actions.bulkReprocess(ctx as never, vi.fn());

    expect(ctx.throw).toHaveBeenCalledWith(400, 'documentIds is required');
  });
});
