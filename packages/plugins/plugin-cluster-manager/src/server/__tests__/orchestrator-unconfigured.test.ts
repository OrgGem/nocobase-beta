/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';
import { orchestratorActions } from '../actions/orchestrator';

function createContext(orchestrator: unknown = null) {
  const ctx = {
    app: {
      pm: {
        get: () => ({
          orchestrator,
          leaderElection: { isLeader: true, leaderId: 'node-1', disabledReason: '' },
        }),
      },
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    },
    action: { params: { stackId: 1 } },
    body: undefined as unknown,
    throw(status: number, message: string): never {
      const error = new Error(message) as Error & { status: number };
      error.status = status;
      throw error;
    },
  };
  return ctx as unknown as Context;
}

describe('orchestratorActions without configured adapter', () => {
  it('returns disconnected status on ping and empty list on networks instead of throwing 503', async () => {
    const pingCtx = createContext(null);
    await orchestratorActions.ping(pingCtx, async () => {});
    expect(pingCtx.body).toEqual({
      adapter: 'none',
      connected: false,
      leader: true,
      leaderId: 'node-1',
      leaderDisabledReason: '',
    });

    const netCtx = createContext(null);
    await orchestratorActions.networks(netCtx, async () => {});
    expect(netCtx.body).toEqual({ data: [] });
  });

  it('still rejects container operations with 503 when adapter is unconfigured', async () => {
    const ctx = createContext(null);
    await expect(orchestratorActions.containers(ctx, async () => {})).rejects.toMatchObject({
      status: 503,
    });
  });
});
