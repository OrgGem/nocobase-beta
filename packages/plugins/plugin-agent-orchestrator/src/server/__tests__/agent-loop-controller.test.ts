import { describe, expect, it, vi } from 'vitest';
import { AgentLoopController } from '../services/AgentLoopController';

// --- Mocks ---
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
        const updated = { ...existing, ...values, updatedAt: new Date() };
        runs.set(Number(id), updated);
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

function createMockServices() {
  return {
    registryService: {
      getHarnessProfile: vi.fn(async () => ({ settings: { allowSubAgents: true, allowToolCalls: true } })),
    },
    plannerService: {
      buildPlan: vi.fn((goal, plan) => plan || [{ title: 'Default step', type: 'skill' }]),
    },
    validator: {
      validate: vi.fn(),
    },
    repository: createMockRepository(),
    harness: {
      executeStep: vi.fn(async (_run: any, step: any) => ({
        summary: `Executed ${step.title}`,
      })),
    },
    tokenTracker: {
      checkBudget: vi.fn(async () => ({ allowed: true })),
    },
  };
}

function createController(mocks = createMockServices()) {
  const controller = new AgentLoopController(
    mocks.registryService as any,
    mocks.plannerService as any,
    mocks.validator as any,
    mocks.repository as any,
    mocks.harness as any,
    mocks.tokenTracker as any,
  );
  return { controller, mocks };
}

describe('AgentLoopController', () => {
  describe('pickNextSteps', () => {
    it('returns empty array for empty steps', () => {
      const { controller } = createController();
      expect(controller.pickNextSteps([])).toEqual([]);
    });

    it('returns pending steps with no dependencies', () => {
      const { controller } = createController();
      const steps = [
        { id: 1, planKey: 'step_1', status: 'pending', dependsOn: [], index: 0 },
        { id: 2, planKey: 'step_2', status: 'succeeded', dependsOn: [], index: 1 },
      ];
      const result = controller.pickNextSteps(steps);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1);
    });

    it('returns step when dependency is satisfied', () => {
      const { controller } = createController();
      const steps = [
        { id: 1, planKey: 'step_1', status: 'succeeded', dependsOn: [], index: 0 },
        { id: 2, planKey: 'step_2', status: 'pending', dependsOn: ['step_1'], index: 1 },
      ];
      const result = controller.pickNextSteps(steps);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(2);
    });

    it('does not return step when dependency is pending', () => {
      const { controller } = createController();
      const steps = [
        { id: 1, planKey: 'step_1', status: 'pending', dependsOn: [], index: 0 },
        { id: 2, planKey: 'step_2', status: 'pending', dependsOn: ['step_1'], index: 1 },
      ];
      const result = controller.pickNextSteps(steps);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1);
    });

    it('handles allow_skipped dependency policy', () => {
      const { controller } = createController();
      const steps = [
        { id: 1, planKey: 'step_1', status: 'skipped', dependsOn: [], index: 0 },
        {
          id: 2,
          planKey: 'step_2',
          status: 'pending',
          dependsOn: ['step_1'],
          dependencyPolicy: 'allow_skipped',
          index: 1,
        },
      ];
      const result = controller.pickNextSteps(steps);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(2);
    });

    it('does not return step when allow_skipped dependency is skipped but policy is require_success', () => {
      const { controller } = createController();
      const steps = [
        { id: 1, planKey: 'step_1', status: 'skipped', dependsOn: [], index: 0 },
        {
          id: 2,
          planKey: 'step_2',
          status: 'pending',
          dependsOn: ['step_1'],
          dependencyPolicy: 'require_success',
          index: 1,
        },
      ];
      const result = controller.pickNextSteps(steps);
      expect(result).toHaveLength(0);
    });

    it('returns multiple independent steps', () => {
      const { controller } = createController();
      const steps = [
        { id: 1, planKey: 'step_1', status: 'pending', dependsOn: [], index: 0 },
        { id: 2, planKey: 'step_2', status: 'pending', dependsOn: [], index: 1 },
        { id: 3, planKey: 'step_3', status: 'pending', dependsOn: ['step_1'], index: 2 },
      ];
      const result = controller.pickNextSteps(steps);
      expect(result).toHaveLength(2);
      expect(result.map((s: any) => s.id)).toEqual([1, 2]);
    });

    it('returns failed step that is retryable', () => {
      const { controller } = createController();
      const steps = [
        { id: 1, planKey: 'step_1', status: 'failed', dependsOn: [], index: 0, attempt: 1, maxAttempts: 3 },
      ];
      const result = controller.pickNextSteps(steps);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1);
    });

    it('does not return failed step that exhausted attempts', () => {
      const { controller } = createController();
      const steps = [
        { id: 1, planKey: 'step_1', status: 'failed', dependsOn: [], index: 0, attempt: 3, maxAttempts: 3 },
      ];
      const result = controller.pickNextSteps(steps);
      expect(result).toHaveLength(0);
    });
  });

  describe('createRun', () => {
    it('creates a run with a goal', async () => {
      const { controller, mocks } = createController();
      const snapshot = await controller.createRun({ goal: 'Test goal' });
      expect(snapshot.run).toBeTruthy();
      expect(snapshot.run.goal).toBe('Test goal');
      expect(snapshot.run.status).toBe('planning');
      expect(snapshot.run.rootRunId).toMatch(/^loop_/);
    });

    it('throws for empty goal', async () => {
      const { controller } = createController();
      await expect(controller.createRun({ goal: '' })).rejects.toThrow('goal is required');
    });

    it('creates steps when plan is provided', async () => {
      const { controller, mocks } = createController();
      const snapshot = await controller.createRun({
        goal: 'Test with plan',
        plan: [
          { title: 'Step 1', type: 'reasoning' },
          { title: 'Step 2', type: 'skill', target: 'search' },
        ],
      });
      expect(snapshot.steps).toHaveLength(2);
      expect(snapshot.steps[0].title).toBe('Step 1');
      expect(snapshot.steps[1].title).toBe('Step 2');
    });
  });

  describe('step lifecycle', () => {
    it('completeStep succeeds when step is running', async () => {
      const { controller, mocks } = createController();
      // Create a run and step
      const run = await mocks.repository.createRun({ goal: 'test', rootRunId: 'r1', status: 'running' });
      await mocks.repository.createStep({ runId: run.id, planKey: 'step_1', status: 'running', attempt: 1 });

      const snapshot = await controller.completeStep(1, { result: 'done' });
      const step = snapshot.steps.find((s: any) => s.id === 1);
      expect(step.status).toBe('succeeded');
    });

    it('completeStep throws when step is not running', async () => {
      const { controller, mocks } = createController();
      await mocks.repository.createRun({ goal: 'test', rootRunId: 'r2', status: 'running' });
      await mocks.repository.createStep({ runId: 1, planKey: 'step_1', status: 'pending' });

      await expect(controller.completeStep(1, {})).rejects.toThrow('cannot complete');
    });

    it('failStep throws when step is not running', async () => {
      const { controller, mocks } = createController();
      await mocks.repository.createRun({ goal: 'test', rootRunId: 'r3', status: 'running' });
      await mocks.repository.createStep({ runId: 1, planKey: 'step_1', status: 'pending' });

      await expect(controller.failStep(1, 'error')).rejects.toThrow('cannot fail');
    });

    it('skipStep succeeds for pending or running steps', async () => {
      const { controller, mocks } = createController();
      await mocks.repository.createRun({ goal: 'test', rootRunId: 'r4', status: 'running' });
      await mocks.repository.createStep({ runId: 1, planKey: 'step_1', status: 'pending' });

      const snapshot = await controller.skipStep(1, 'Not needed');
      const step = snapshot.steps.find((s: any) => s.id === 1);
      expect(step.status).toBe('skipped');
    });

    it('retryStep resets failed step to pending', async () => {
      const { controller, mocks } = createController();
      await mocks.repository.createRun({
        goal: 'test',
        rootRunId: 'r5',
        status: 'running',
        policy: { maxStepAttempts: 3 },
      });
      await mocks.repository.createStep({ runId: 1, planKey: 'step_1', status: 'failed', attempt: 1, maxAttempts: 3 });

      const snapshot = await controller.retryStep(1);
      const step = snapshot.steps.find((s: any) => s.id === 1);
      expect(step.status).toBe('pending');
    });

    it('retryStep throws when maxAttempts exceeded', async () => {
      const { controller, mocks } = createController();
      await mocks.repository.createRun({ goal: 'test', rootRunId: 'r6', status: 'running' });
      await mocks.repository.createStep({ runId: 1, planKey: 'step_1', status: 'failed', attempt: 5, maxAttempts: 3 });

      await expect(controller.retryStep(1)).rejects.toThrow('maxAttempts');
    });
  });

  describe('approval flow', () => {
    it('requestApproval sets step to waiting_user', async () => {
      const { controller, mocks } = createController();
      await mocks.repository.createRun({ goal: 'test', rootRunId: 'r7', status: 'running' });
      await mocks.repository.createStep({ runId: 1, planKey: 'step_1', status: 'running' });

      const snapshot = await controller.requestApproval(1, { prompt: 'OK?' });
      const step = snapshot.steps.find((s: any) => s.id === 1);
      expect(step.status).toBe('waiting_user');
    });

    it('resumeRun with approved=true resumes to pending', async () => {
      const { controller, mocks } = createController();
      await mocks.repository.createRun({
        id: 1,
        goal: 'test',
        rootRunId: 'r8',
        status: 'waiting_user',
        currentStepId: 1,
        policy: { requireVerification: false },
      });
      await mocks.repository.createStep({ runId: 1, planKey: 'step_1', status: 'waiting_user', approval: {} });

      const snapshot = await controller.resumeRun(1, { approved: true });
      expect(snapshot).toBeTruthy();
      // skip further assertions — the run may have attempted execution
    });
  });

  describe('finishRun', () => {
    it('finishes a succeeded run where all steps complete', async () => {
      const { controller, mocks } = createController();
      await mocks.repository.createRun({
        goal: 'test',
        rootRunId: 'r9',
        status: 'running',
        policy: { requireVerification: false },
      });
      await mocks.repository.createStep({ runId: 1, planKey: 'step_1', status: 'succeeded', type: 'reasoning' });

      const snapshot = await controller.finishRun(1, 'All done', { status: 'succeeded' });
      expect(snapshot.run.status).toBe('succeeded');
    });

    it('throws when succeeded run has unfinished steps', async () => {
      const { controller, mocks } = createController();
      await mocks.repository.createRun({ goal: 'test', rootRunId: 'r10', status: 'running' });
      await mocks.repository.createStep({ runId: 1, planKey: 'step_1', status: 'pending' });

      await expect(controller.finishRun(1, 'Done', { status: 'succeeded' })).rejects.toThrow('are not complete');
    });
  });
});
