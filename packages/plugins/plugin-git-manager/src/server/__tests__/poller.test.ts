import { Context } from '@nocobase/actions';
import { vi } from 'vitest';

vi.mock('../poller', () => ({
  pollAllRepos: vi.fn(),
  pollOneRepo: vi.fn(),
  getPollerStatus: vi.fn(),
}));

import { pollNow } from '../actions/poller';
import { pollAllRepos, pollOneRepo } from '../poller';

describe('Git Manager poll action', () => {
  it('uses a repository ID sent in the request body instead of polling every repository', async () => {
    const repository = { id: 10 };
    vi.mocked(pollOneRepo).mockResolvedValue({ scanned: 1, triggered: 0 });
    const context = {
      action: { params: {} },
      request: { body: { repositoryId: 10 } },
      app: {},
      db: {
        getRepository: vi.fn().mockReturnValue({
          findOne: vi.fn().mockResolvedValue(repository),
        }),
      },
      throw: vi.fn(),
      body: undefined as unknown,
    };
    const next = vi.fn().mockResolvedValue(undefined);

    await pollNow(context as unknown as Context, next);

    expect(pollOneRepo).toHaveBeenCalledWith(context.app, repository);
    expect(pollAllRepos).not.toHaveBeenCalled();
    expect(context.body).toEqual({ success: true, data: { scanned: 1, triggered: 0 } });
  });
});
