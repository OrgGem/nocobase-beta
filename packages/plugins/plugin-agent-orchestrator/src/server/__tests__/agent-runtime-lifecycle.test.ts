import { AgentRuntimeLifecycle } from '../services/AgentRuntimeLifecycle';

describe('AgentRuntimeLifecycle', () => {
  it('runs registered hooks in registration order and supports cleanup', async () => {
    const lifecycle = new AgentRuntimeLifecycle();
    const calls: string[] = [];
    const cleanup = lifecycle.registerBeforeRunHook('first', () => calls.push('first'));
    lifecycle.registerBeforeRunHook('second', () => calls.push('second'));
    const context = {
      ctx: {},
      source: 'api' as const,
      employee: {},
      sessionId: 'session-1',
      messages: [],
      metadata: {},
    };

    await lifecycle.runBeforeHooks(context);
    cleanup();
    await lifecycle.runBeforeHooks(context);

    expect(calls).toEqual(['first', 'second', 'second']);
  });

  it('isolates a failed hook and continues with later hooks', async () => {
    const failures: string[] = [];
    const calls: string[] = [];
    const lifecycle = new AgentRuntimeLifecycle((hookType, name) => failures.push(`${hookType}:${name}`));
    lifecycle.registerBeforeRunHook('broken', () => {
      throw new Error('boom');
    });
    lifecycle.registerBeforeRunHook('healthy', () => calls.push('healthy'));

    await lifecycle.runBeforeHooks({
      ctx: {},
      source: 'api',
      employee: {},
      sessionId: 'session-1',
      messages: [],
      metadata: {},
    });

    expect(failures).toEqual(['beforeRun:broken']);
    expect(calls).toEqual(['healthy']);
  });
});
