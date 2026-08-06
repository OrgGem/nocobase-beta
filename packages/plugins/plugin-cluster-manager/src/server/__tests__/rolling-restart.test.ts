import { describe, expect, it, vi } from 'vitest';
import {
  RollingRestartError,
  runRollingRestartSequence,
  type RollingRestartNode,
  type RollingRestartOptions,
} from '../services/rolling-restart';

function appNode(id: string, name: string, generationId = `${id}-generation-1`): RollingRestartNode {
  return {
    id,
    name,
    hostname: name,
    generationId,
    role: 'app',
    status: 'online',
    lastHeartbeatAt: 1_000_000,
    probeUrl: `http://${name}:13000`,
  };
}

function options(nodes: RollingRestartNode[]): RollingRestartOptions {
  return {
    restartId: 'restart-1',
    mode: 'hard',
    nodes,
    coordinatorId: 'main',
    stabilizationMs: 1000,
    recoveryTimeoutMs: 10000,
    pollIntervalMs: 1000,
    heartbeatMaxAgeMs: 25000,
  };
}

describe('runRollingRestartSequence', () => {
  it('restarts remote app nodes sequentially and leaves the coordinator until last', async () => {
    let now = 1_000_000;
    let state = [appNode('main', 'app-main'), appNode('backup-1', 'app-backup-1'), appNode('backup-2', 'app-backup-2')];
    const restartOrder: string[] = [];
    const restartNode = vi.fn(async (target: RollingRestartNode) => {
      restartOrder.push(target.id);
      state = state.map((node) =>
        node.id === target.id ? { ...node, generationId: `${node.id}-generation-2`, lastHeartbeatAt: now + 100 } : node,
      );
      now += 100;
    });

    const result = await runRollingRestartSequence(options([...state]), {
      listNodes: async () => state,
      probeNode: async () => true,
      restartNode,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      now: () => now,
    });

    expect(restartOrder).toEqual(['backup-1', 'backup-2']);
    expect(result.published.map((node) => node.id)).toEqual(['backup-1', 'backup-2']);
    expect(result.coordinator?.id).toBe('main');
    expect(restartNode).toHaveBeenCalledTimes(2);
  });

  it('stops the sequence when a restarted node does not return with a new generation', async () => {
    let now = 1_000_000;
    const state = [
      appNode('main', 'app-main'),
      appNode('backup-1', 'app-backup-1'),
      appNode('backup-2', 'app-backup-2'),
    ];
    const restartNode = vi.fn(async () => undefined);

    await expect(
      runRollingRestartSequence(
        { ...options(state), recoveryTimeoutMs: 2000, stabilizationMs: 0 },
        {
          listNodes: async () => state,
          probeNode: async () => true,
          restartNode,
          sleep: async (milliseconds) => {
            now += milliseconds;
          },
          now: () => now,
        },
      ),
    ).rejects.toMatchObject<Partial<RollingRestartError>>({ code: 'node-recovery-timeout' });
    expect(restartNode).toHaveBeenCalledTimes(1);
  });

  it('refuses to restart an app node when no healthy peer can serve traffic', async () => {
    const state = [appNode('main', 'app-main'), appNode('backup-1', 'app-backup-1')];
    const restartNode = vi.fn(async () => undefined);

    await expect(
      runRollingRestartSequence(options(state), {
        listNodes: async () => state,
        probeNode: async () => false,
        restartNode,
        sleep: async () => undefined,
        now: () => 1_000_000,
      }),
    ).rejects.toMatchObject<Partial<RollingRestartError>>({ code: 'no-ready-peer' });
    expect(restartNode).not.toHaveBeenCalled();
  });

  it('requires restart-generation metadata before issuing a restart', async () => {
    const backup = appNode('backup-1', 'app-backup-1');
    delete backup.generationId;
    const state = [appNode('main', 'app-main'), backup];
    const restartNode = vi.fn(async () => undefined);

    await expect(
      runRollingRestartSequence(options(state), {
        listNodes: async () => state,
        probeNode: async () => true,
        restartNode,
        sleep: async () => undefined,
        now: () => 1_000_000,
      }),
    ).rejects.toMatchObject<Partial<RollingRestartError>>({ code: 'generation-unavailable' });
    expect(restartNode).not.toHaveBeenCalled();
  });
});
