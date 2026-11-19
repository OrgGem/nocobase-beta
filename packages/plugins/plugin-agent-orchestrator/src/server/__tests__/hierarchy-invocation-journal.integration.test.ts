/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockServer, type MockServer } from '@nocobase/test';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { PluginAgentOrchestratorServer } from '../plugin';
import {
  HierarchyInvocationJournal,
  type HierarchyInvocationKey,
  type ReserveHierarchyInvocation,
} from '../services/HierarchyInvocationJournal';

const suffix = `${process.pid}-${Date.now()}`;

function invocation(overrides: Partial<ReserveHierarchyInvocation> = {}): ReserveHierarchyInvocation {
  return {
    ownerId: 7001,
    rootSessionId: `root-${suffix}`,
    parentSessionId: `parent-${suffix}`,
    parentToolCallId: `tool-${suffix}`,
    parentEmployee: 'orchestrator',
    employeeUsername: 'specialist',
    role: 'specialist',
    question: 'Find the requested evidence.',
    snapshot: {
      profileTag: 'test-profile',
      profileVersion: 2,
      profileVersionId: 22,
      policy: { tools: { allow: ['read_file'] } },
      model: { llmService: 'mock', model: 'specialist-lite' },
      ancestors: ['orchestrator'],
    },
    ...overrides,
  };
}

function keyOf(input: ReserveHierarchyInvocation): HierarchyInvocationKey {
  return {
    ownerId: input.ownerId,
    parentSessionId: input.parentSessionId,
    parentToolCallId: input.parentToolCallId,
  };
}

describe('hierarchy invocation journal persistence', () => {
  let app: MockServer;
  let journal: HierarchyInvocationJournal;

  beforeAll(async () => {
    app = await createMockServer({
      plugins: ['nocobase', PluginAgentOrchestratorServer],
      name: `hierarchy-invocation-journal-${suffix}`,
      skipSupervisor: true,
    });
    journal = new HierarchyInvocationJournal(app.db);
  });

  afterAll(async () => {
    await app?.destroy();
  });

  it('reserves one owner-scoped idempotency key and rejects conflicting reuse', async () => {
    const input = invocation();
    const first = await journal.reserve(input);
    const retry = await journal.reserve(input);

    expect(retry.get('id')).toBe(first.get('id'));
    expect(retry.get('status')).toBe('reserved');
    await expect(journal.reserve(invocation({ ...input, question: 'A different task.' }))).rejects.toThrow(
      'identity does not match',
    );
    await expect(journal.claim({ ...keyOf(input), ownerId: input.ownerId + 1 })).rejects.toThrow('unavailable');
  });

  it('claims with compare-and-swap, attaches the child, and fences completion to the active token', async () => {
    const input = invocation({ parentToolCallId: `claim-${suffix}` });
    const key = keyOf(input);
    await journal.reserve(input);

    const claims = await Promise.allSettled([journal.claim(key), journal.claim(key)]);
    const acquired = claims.filter((result) => result.status === 'fulfilled');
    const rejected = claims.filter((result) => result.status === 'rejected');
    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (acquired[0].status !== 'fulfilled') throw new Error('Expected one active hierarchy claim.');

    const { token } = acquired[0].value;
    await journal.attachChild(key, token, `child-${suffix}`);
    await expect(journal.complete(key, 'stale-token', { messageId: 'stale' })).rejects.toThrow('no longer active');
    await journal.complete(key, token, { messageId: `result-${suffix}`, model: 'specialist-lite' });
    const stored = await app.db.getRepository('agentHierarchyInvocations').findOne({
      filter: { parentSessionId: key.parentSessionId, parentToolCallId: key.parentToolCallId },
    });
    expect(stored?.get('status')).toBe('succeeded');
    expect(stored?.get('childSessionId')).toBe(`child-${suffix}`);
    expect(stored?.get('result')).toEqual({ messageId: `result-${suffix}`, model: 'specialist-lite' });
  });

  it('never automatically reclaims a running or uncertain invocation', async () => {
    const input = invocation({ parentToolCallId: `uncertain-${suffix}` });
    const key = keyOf(input);
    await journal.reserve(input);
    const { token } = await journal.claim(key);
    await expect(journal.claim(key)).rejects.toThrow('not ready');
    await journal.markUncertain(key, token);
    await expect(journal.claim(key)).rejects.toThrow('not ready');
    const uncertain = await journal.get(key);
    expect(uncertain.get('status')).toBe('uncertain');
    expect(uncertain.get('claimToken')).toBeNull();
    await expect(journal.complete(key, token, { messageId: `late-${suffix}` })).rejects.toThrow('no longer active');
    expect((await journal.get(key)).get('result')).toBeNull();
  });
});
