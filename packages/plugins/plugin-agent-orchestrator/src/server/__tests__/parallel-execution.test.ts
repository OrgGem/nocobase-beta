import { describe, expect, it, vi } from 'vitest';
import { AgentLoopController } from '../services/AgentLoopController';

// ── Mocks ──
function createMockRepository() {
  const runs = new Map<number, any>();
  const steps = new Map<number, any>();
  const events: any[] = [];
  let runIdCounter = 1;
  let stepIdCounter = 1;

  return {
    _runs: runs,
    _steps: steps,
    _events: events,

    requireRun: vi.fn(async (id: number) => {
      const run = runs.get(Number(id));
      if (!run) throw new Error(`Run ${id} not found`);
      return { ...run };
    }),
    getRun: vi.fn(async (id: number) => {
      const run = runs.get(Number(id));
      return run ? { ...run } : null;
    }),
    createRun: vi.fn(async (values: any) => {
      const id = runIdCounter++;
      const run = { id, ...values, createdAt: new Date(), updatedAt: new Date() };
      runs.set(id, run);
      return { ...run };
    }),
    updateRun: vi.fn(async (id: number, values: any) => {
      const existing = runs.get(Number(id));
      if (existing) {
        runs.set(Number(id), { ...existing, ...values, updatedAt: new Date() });
      }
    }),
    requireStep: vi.fn(async (id: number) => {
      const step = steps.get(Number(id));
      if (!step) throw new Error(`Step ${id} not found`);
      return { ...step };
    }),
    getStep: vi.fn(async (id: number) => {
      const step = steps.get(Number(id));
      return step ? { ...step } : null;
    }),
    createStep: vi.fn(async (values: any) => {
      const id = stepIdCounter++;
      const step = { id, ...values, createdAt: new Date(), updatedAt: new Date() };
      steps.set(id, step);
      return { ...step };
    }),
    updateStep: vi.fn(async (id: number, values: any) => {
      const existing = steps.get(Number(id));
      if (existing) {
        steps.set(Number(id), { ...existing, ...values, updatedAt: new Date() });
      }
    }),
    getSteps: vi.fn(async (runId: number) => {
      return Array.from(steps.values())
        .filter((s) => s.runId === runId)
        .map((s) => ({ ...s }))
        .sort((a, b) => (a.index || 0) - (b.index || 0));
    }),
    createEvent: vi.fn(async (values: any) => {
      const event = { id: events.length + 1, ...values, createdAt: new Date() };
      events.push(event);
      return event;
    }),
    getEvents: vi.fn(async () => []),
    getLinkedSpans: vi.fn(async () => []),
    getLinkedSkillExecutions: vi.fn(async () => []),
    lockRun: vi.fn(async () => true),
    unlockRun: vi.fn(async () => {}),
  };
}

function createController(harnessExecute?: any) {
  const repository = createMockRepository();
  const harness = {
    executeStep:
      harnessExecute ||
      vi.fn(async (_run: any, step: any) => ({
        summary: `Executed: ${step.title}`,
      })),
  };

  const controller = new AgentLoopController(
    { getHarnessProfile: vi.fn(async () => ({ settings: {} })) } as any,
    { buildPlan: vi.fn() } as any,
    { validate: vi.fn() } as any,
    repository as any,
    harness as any,
    { checkBudget: vi.fn(async () => ({ allowed: true })) } as any,
  );

  return { controller, repository, harness };
}

async function seedRunWithSteps(
  repository: any,
  stepDefs: { planKey: string; dependsOn?: string[]; title?: string; type?: string; target?: string }[],
) {
  const run = await repository.createRun({
    goal: 'parallel test',
    rootRunId: 'parallel-test-root',
    status: 'approved',
    policy: {
      maxIterations: 20,
      maxStepAttempts: 2,
      allowReplan: false,
      requireVerification: false,
      stopOnApprovalRequired: false,
      maxConcurrency: 5,
    },
    metadata: {
      harnessSettings: {},
      approvalMode: 'plan_first',
    },
  });

  for (let i = 0; i < stepDefs.length; i++) {
    const def = stepDefs[i];
    await repository.createStep({
      runId: run.id,
      planKey: def.planKey,
      index: i,
      title: def.title || `Step ${i + 1}`,
      type: def.type || 'reasoning',
      target: def.target || '',
      status: 'pending',
      attempt: 0,
      maxAttempts: 2,
      dependsOn: def.dependsOn || [],
    });
  }

  return run.id;
}

describe('Parallel execution', () => {
  it('executes independent steps concurrently', async () => {
    const executeOrder: number[] = [];
    const { controller, repository } = createController(
      vi.fn(async (_run: any, step: any) => {
        executeOrder.push(step.id);
        return { summary: `Done: ${step.title}` };
      }),
    );

    // 3 independent steps + 1 dependent on the last
    const runId = await seedRunWithSteps(repository, [
      { planKey: 'step_a', title: 'Research A' },
      { planKey: 'step_b', title: 'Research B' },
      { planKey: 'step_c', title: 'Research C' },
      { planKey: 'step_d', title: 'Combine', dependsOn: ['step_a', 'step_b', 'step_c'] },
    ]);

    const snapshot = await controller.executeApprovedPlan(runId);
    expect(snapshot.run.status).toBe('succeeded');
    expect(executeOrder.length).toBe(4);

    // Steps A, B, C should have been executed before D
    const aIdx = executeOrder.indexOf(1);
    const bIdx = executeOrder.indexOf(2);
    const cIdx = executeOrder.indexOf(3);
    const dIdx = executeOrder.indexOf(4);
    expect(dIdx).toBeGreaterThan(aIdx);
    expect(dIdx).toBeGreaterThan(bIdx);
    expect(dIdx).toBeGreaterThan(cIdx);
  });

  it('respects maxConcurrency limit', async () => {
    let concurrentMax = 0;
    let currentConcurrent = 0;

    const { controller, repository } = createController(
      vi.fn(async (_run: any, _step: any) => {
        currentConcurrent++;
        concurrentMax = Math.max(concurrentMax, currentConcurrent);
        // Simulate async work
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        currentConcurrent--;
        return { summary: 'done' };
      }),
    );

    const runId = await seedRunWithSteps(repository, [
      { planKey: 'step_1', title: 'Task 1' },
      { planKey: 'step_2', title: 'Task 2' },
      { planKey: 'step_3', title: 'Task 3' },
      { planKey: 'step_4', title: 'Task 4' },
      { planKey: 'step_5', title: 'Task 5' },
      { planKey: 'step_6', title: 'Task 6' },
    ]);

    // The repo policy has maxConcurrency=5
    await controller.executeApprovedPlan(runId);
    // With 6 independent steps and concurrency 5, at most 5 should run simultaneously
    expect(concurrentMax).toBeLessThanOrEqual(5);
  });

  it('handles partial failure in a batch', async () => {
    const { controller, repository } = createController(
      vi.fn(async (_run: any, step: any) => {
        if (step.planKey === 'step_b') {
          throw new Error('Step B failed');
        }
        return { summary: `Done: ${step.title}` };
      }),
    );

    const runId = await seedRunWithSteps(repository, [
      { planKey: 'step_a', title: 'Works fine' },
      { planKey: 'step_b', title: 'Fails', type: 'skill', target: 'bad_tool' },
      { planKey: 'step_c', title: 'Also fine' },
    ]);

    const snapshot = await controller.executeApprovedPlan(runId);
    // Step B should be marked failed
    const failedStep = snapshot.steps.find((s: any) => s.planKey === 'step_b');
    expect(failedStep.status).toBe('failed');
  });

  it('executes chain: step1 → step2 → step3 sequentially', async () => {
    const executeOrder: number[] = [];
    const { controller, repository } = createController(
      vi.fn(async (_run: any, step: any) => {
        executeOrder.push(step.id);
        return { summary: `Done: ${step.title}` };
      }),
    );

    const runId = await seedRunWithSteps(repository, [
      { planKey: 'step_1', title: 'First' },
      { planKey: 'step_2', title: 'Second', dependsOn: ['step_1'] },
      { planKey: 'step_3', title: 'Third', dependsOn: ['step_2'] },
    ]);

    const snapshot = await controller.executeApprovedPlan(runId);
    expect(snapshot.run.status).toBe('succeeded');
    expect(executeOrder).toEqual([1, 2, 3]);
  });

  it('executes diamond dependencies: A → (B, C) → D', async () => {
    const executeOrder: number[] = [];
    const { controller, repository } = createController(
      vi.fn(async (_run: any, step: any) => {
        executeOrder.push(step.id);
        return { summary: `Done: ${step.title}` };
      }),
    );

    const runId = await seedRunWithSteps(repository, [
      { planKey: 'step_a', title: 'Root' },
      { planKey: 'step_b', title: 'Branch 1', dependsOn: ['step_a'] },
      { planKey: 'step_c', title: 'Branch 2', dependsOn: ['step_a'] },
      { planKey: 'step_d', title: 'Merge', dependsOn: ['step_b', 'step_c'] },
    ]);

    const snapshot = await controller.executeApprovedPlan(runId);
    expect(snapshot.run.status).toBe('succeeded');

    // A must be first, D must be last
    const aIdx = executeOrder.indexOf(1);
    const bIdx = executeOrder.indexOf(2);
    const cIdx = executeOrder.indexOf(3);
    const dIdx = executeOrder.indexOf(4);
    expect(aIdx).toBe(0);
    expect(dIdx).toBe(3);
    // B and C can be in any order but both after A and before D
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(cIdx).toBeGreaterThan(aIdx);
    expect(bIdx).toBeLessThan(dIdx);
    expect(cIdx).toBeLessThan(dIdx);
  });

  it('stops execution when budget is exceeded', async () => {
    const { controller, repository } = createController();

    // Override tokenTracker
    const tokenTracker = {
      checkBudget: vi.fn(async () => ({ allowed: false, reason: 'Budget exceeded' })),
    };
    const harness = {
      executeStep: vi.fn(async () => ({ summary: 'done' })),
    };
    const repo2 = createMockRepository();
    const controller2 = new AgentLoopController(
      { getHarnessProfile: vi.fn(async () => ({ settings: {} })) } as any,
      { buildPlan: vi.fn() } as any,
      { validate: vi.fn() } as any,
      repo2 as any,
      harness as any,
      tokenTracker as any,
    );

    const runId = await seedRunWithSteps(repo2, [{ planKey: 'step_1', title: 'Expensive step' }]);

    const snapshot = await controller2.executeApprovedPlan(runId);
    expect(snapshot.run.status).toBe('failed');
  });

  it('pauses for approval and does not continue', async () => {
    const { controller, repository } = createController(
      vi.fn(async (_run: any, _step: any) => {
        throw new Error('requires_approval');
      }),
    );

    const runId = await seedRunWithSteps(repository, [
      { planKey: 'step_1', title: 'Needs approval', type: 'tool', target: 'restricted_tool' },
    ]);

    const snapshot = await controller.executeApprovedPlan(runId);
    expect(snapshot.run.status).toBe('waiting_user');
  });
});
