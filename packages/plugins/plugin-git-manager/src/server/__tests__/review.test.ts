/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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

function createApp(enqueue?: (input: Record<string, unknown>) => Promise<number>) {
  const reviewService = enqueue ? { enqueue } : undefined;
  return {
    pm: {
      get: vi.fn((name: string) => (name === 'git-manager' ? { reviewService } : undefined)),
    },
  } as unknown as Application;
}

describe('Git Manager review admission adapter', () => {
  it('delegates the selected manual request to the durable review service', async () => {
    const enqueue = vi.fn(async () => 99);
    const app = createApp(enqueue);
    const input = {
      flowId: 8,
      repositoryId: 20,
      targetType: 'commit' as const,
      commitSha: 'a'.repeat(40),
      triggeredBy: 'manual' as const,
      userId: 7,
      actorRoles: ['root'],
    };

    await expect(triggerReviewInternal(app, input)).resolves.toBe(99);
    expect(app.pm.get).toHaveBeenCalledWith('git-manager');
    expect(enqueue).toHaveBeenCalledWith(input);
  });

  it('fails closed when the durable review service is not registered', async () => {
    await expect(
      triggerReviewInternal(createApp(), {
        repositoryId: 20,
        targetType: 'branch',
        branch: 'main',
        userId: 7,
        actorRoles: ['root'],
      }),
    ).rejects.toThrow('Git review workflow service is unavailable');
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
});
