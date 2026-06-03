import { createMockServer } from '@nocobase/test';

describe('Agent Orchestrator plugin smoke', () => {
  let app;

  afterEach(async () => {
    await app?.destroy();
  });

  it('loads without starting the full app', async () => {
    app = await createMockServer({
      plugins: ['nocobase', 'plugin-agent-orchestrator'],
    });
    expect(app).toBeTruthy();
  });

  it('registers collection definitions', async () => {
    app = await createMockServer({
      plugins: ['nocobase', 'plugin-agent-orchestrator'],
    });
    const collections = [
      'agentLoopRuns',
      'agentLoopSteps',
      'agentLoopEvents',
      'orchestratorConfig',
      'orchestratorLogs',
      'agentExecutionSpans',
      'agentHarnessProfiles',
      'skillDefinitions',
      'skillExecutions',
      'skillLoopConfigs',
      'skillWorkerConfigs',
    ];
    for (const name of collections) {
      const collection = app.db.getCollection(name);
      expect(collection).toBeTruthy();
    }
  });

  it('has agentLoopRuns schema with required fields', async () => {
    app = await createMockServer({
      plugins: ['nocobase', 'plugin-agent-orchestrator'],
    });
    const collection = app.db.getCollection('agentLoopRuns');
    expect(collection).toBeTruthy();

    const fields = {
      goal: 'text',
      status: 'string',
      planVersion: 'integer',
      iterationCount: 'integer',
      totalTokens: 'integer',
      totalCost: 'float',
    };

    for (const [name, type] of Object.entries(fields)) {
      const field = collection.getField(name);
      expect(field).toBeTruthy();
      expect(field.type).toBe(type);
    }
  });

  it('can create an agentLoopRun record', async () => {
    app = await createMockServer({
      plugins: ['nocobase', 'plugin-agent-orchestrator'],
    });
    const repo = app.db.getRepository('agentLoopRuns');
    const run = await repo.create({
      values: {
        rootRunId: 'test-root',
        goal: 'Test goal',
        status: 'planning',
      },
    });
    expect(run.id).toBeTruthy();
    expect(run.goal).toBe('Test goal');
    expect(run.status).toBe('planning');
    expect(run.rootRunId).toBe('test-root');
  });

  it('can create agentLoopSteps with parent-child relationship', async () => {
    app = await createMockServer({
      plugins: ['nocobase', 'plugin-agent-orchestrator'],
    });
    const runRepo = app.db.getRepository('agentLoopRuns');
    const stepRepo = app.db.getRepository('agentLoopSteps');

    const run = await runRepo.create({
      values: {
        rootRunId: 'test-root-2',
        goal: 'Multi-step test',
      },
    });

    const parentStep = await stepRepo.create({
      values: {
        runId: run.id,
        planKey: 'step_1',
        title: 'Parent step',
        type: 'reasoning',
        status: 'succeeded',
      },
    });

    const childStep = await stepRepo.create({
      values: {
        runId: run.id,
        planKey: 'step_2',
        title: 'Child step',
        type: 'skill',
        status: 'pending',
        dependsOn: ['step_1'],
      },
    });

    expect(parentStep.id).toBeTruthy();
    expect(childStep.id).toBeTruthy();
    expect(childStep.dependsOn).toEqual(['step_1']);
  });
});
