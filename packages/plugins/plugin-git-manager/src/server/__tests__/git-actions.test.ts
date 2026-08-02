import { Context } from '@nocobase/actions';
import { vi } from 'vitest';

import { getRepo } from '../actions/git-actions';

describe('Git Manager git actions', () => {
  it('uses the repository ID from the request body over the URL parameter', async () => {
    const repository = { id: 20 };
    const findOne = vi.fn().mockResolvedValue(repository);
    const context = {
      action: { params: { repositoryId: 10 } },
      request: { body: { repositoryId: 20 } },
      db: {
        getRepository: vi.fn().mockReturnValue({ findOne }),
      },
      throw: vi.fn(),
    };

    const result = await getRepo(context as unknown as Context);

    expect(findOne).toHaveBeenCalledWith({ filterByTk: 20 });
    expect(result).toBe(repository);
  });
});
