import type { Application } from '@nocobase/server';
import { vi } from 'vitest';

import { resolveBackgroundReviewRoles, resolveImmutableReviewActorId, triggerReviewInternal } from '../actions/review';

function record(values: Record<string, unknown>) {
  return {
    get(attribute: string) {
      return values[attribute];
    },
  };
}

function createReviewApp(flowRepositoryId: number | null, existingReview: Record<string, unknown> | null = null) {
  const flow = record({
    id: 8,
    enabled: true,
    repositoryId: flowRepositoryId,
    aiEmployeeUsername: 'reviewer',
    name: 'Review flow',
    postMode: 'manual',
    llmService: null,
    model: null,
    instructions: null,
    branchFilter: null,
  });
  const flowsRepository = {
    findOne: vi.fn().mockResolvedValue(flow),
  };
  const repositoriesRepository = {
    findOne: vi.fn().mockResolvedValue(record({ id: 20 })),
  };
  const reviewsRepository = {
    findOne: vi.fn().mockResolvedValue(existingReview ? record(existingReview) : null),
    create: vi.fn().mockResolvedValue(record({ id: 99 })),
    update: vi.fn().mockResolvedValue(undefined),
  };
  const getRepository = vi.fn((name: string) => {
    if (name === 'gitReviewFlows') return flowsRepository;
    if (name === 'gitRepositories') return repositoriesRepository;
    if (name === 'gitCodeReviews') return reviewsRepository;
    throw new Error(`Unexpected repository ${name}`);
  });
  const app = {
    db: { getRepository },
    lockManager: {
      runExclusive: vi.fn(async (_key: string, callback: () => Promise<unknown>) => callback()),
    },
    serving: vi.fn().mockReturnValue(false),
    eventQueue: {
      publish: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as Application;

  return { app, repositoriesRepository, reviewsRepository };
}

describe('Git Manager review flows', () => {
  it('rejects an explicitly selected flow from another repository', async () => {
    const { app, repositoriesRepository } = createReviewApp(10);

    await expect(
      triggerReviewInternal(app, {
        flowId: 8,
        repositoryId: 20,
        targetType: 'branch',
        branch: 'main',
      }),
    ).rejects.toMatchObject({ status: 400, message: 'Review flow does not belong to this repository' });

    expect(repositoriesRepository.findOne).not.toHaveBeenCalled();
  });

  it('allows an explicitly selected global flow', async () => {
    const { app, repositoriesRepository, reviewsRepository } = createReviewApp(null);

    const reviewId = await triggerReviewInternal(app, {
      flowId: 8,
      repositoryId: 20,
      targetType: 'branch',
      branch: 'main',
      userId: 7,
    });

    expect(reviewId).toBe(99);
    expect(repositoriesRepository.findOne).toHaveBeenCalledWith({ filterByTk: 20 });
    expect(reviewsRepository.create).toHaveBeenCalledWith({
      values: expect.objectContaining({ flowId: 8, repositoryId: 20, createdById: 7 }),
    });
  });

  it('uses the immutable creator field instead of review metadata for worker identity', () => {
    expect(resolveImmutableReviewActorId(record({ createdById: 7, metadata: { userId: 1 } }))).toBe(7);
    expect(resolveImmutableReviewActorId(record({ createdById: null, metadata: { userId: 1 } }))).toBeNull();
  });

  it('fails closed when a manual review actor has no resolvable roles', async () => {
    const db = {
      getRepository: vi.fn().mockReturnValue({ find: vi.fn().mockResolvedValue([]) }),
    };

    await expect(resolveBackgroundReviewRoles(db, 7)).rejects.toThrow('Unable to resolve roles for review actor');
    await expect(resolveBackgroundReviewRoles(db, null)).resolves.toEqual(['admin']);
  });

  it.each(['completed', 'failed'])(
    'refreshes the immutable actor when a different user requeues a %s review',
    async (status) => {
      const { app, reviewsRepository } = createReviewApp(null, {
        id: 99,
        status,
        latestSha: null,
        createdById: 1,
      });

      await triggerReviewInternal(app, {
        flowId: 8,
        repositoryId: 20,
        targetType: 'branch',
        branch: 'main',
        triggeredBy: 'manual',
        userId: 7,
      });

      expect(reviewsRepository.update).toHaveBeenCalledWith({
        filterByTk: 99,
        values: expect.objectContaining({
          createdById: 7,
          triggeredBy: 'manual',
          status: 'pending',
          metadata: expect.objectContaining({ userId: 7 }),
        }),
      });
      expect(reviewsRepository.create).not.toHaveBeenCalled();
    },
  );
});
