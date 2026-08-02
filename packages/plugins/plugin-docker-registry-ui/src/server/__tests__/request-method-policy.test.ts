import type { Context, Next } from '@nocobase/actions';
import { describe, expect, it, vi } from 'vitest';
import { ACTION_METHODS, createDockerRegistryRequestMethodPolicy } from '../middlewares/request-method-policy';

function context(resourceName: string, actionName: string, method: string): Context {
  return {
    action: { resourceName, actionName },
    method,
    throw(status: number, message: string) {
      throw Object.assign(new Error(message), { status });
    },
  } as unknown as Context;
}

describe('Docker Registry request method policy', () => {
  it('keeps every custom action in the explicit method map', () => {
    expect(ACTION_METHODS).toEqual({
      getSettings: ['GET'],
      getPublicConfiguration: ['GET'],
      updateSettings: ['POST'],
      testConnection: ['GET'],
      testConnectionDraft: ['POST'],
      listRepositories: ['GET'],
      listTags: ['GET'],
      getImageDetails: ['GET'],
      getDeleteImpact: ['GET'],
      deleteTag: ['POST'],
      getRepositoryDeleteImpact: ['GET'],
      deleteRepositoryContents: ['POST'],
      downloadImage: ['GET'],
      uploadImage: ['POST'],
    });
  });

  it('rejects GET for destructive actions and allows POST', async () => {
    const middleware = createDockerRegistryRequestMethodPolicy();
    const next = vi.fn<Next>();
    await expect(middleware(context('dockerRegistry', 'deleteTag', 'GET'), next)).rejects.toMatchObject({
      status: 405,
    });
    expect(next).not.toHaveBeenCalled();

    await middleware(context('dockerRegistry', 'deleteTag', 'POST'), next);
    await expect(middleware(context('dockerRegistry', 'deleteRepositoryContents', 'GET'), next)).rejects.toMatchObject({
      status: 405,
    });
    await middleware(context('dockerRegistry', 'deleteRepositoryContents', 'POST'), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('does not interfere with resources owned by other plugins', async () => {
    const next = vi.fn<Next>();
    await createDockerRegistryRequestMethodPolicy()(context('otherResource', 'deleteTag', 'GET'), next);
    expect(next).toHaveBeenCalledOnce();
  });
});
