import { createMockServer, MockServer } from '@nocobase/test';
import { PluginAgentOrchestratorServer } from '../plugin';
import { ensureAgentOrchestratorIndexes } from '../utils/ensure-indexes';

type DatabaseIndex = {
  name?: string;
  unique?: boolean;
  fields?: Array<{ attribute?: string; name?: string }>;
};

describe('Agent Orchestrator plugin smoke', () => {
  let app: MockServer;

  beforeAll(async () => {
    const createdApp = await createMockServer({
      plugins: ['nocobase', PluginAgentOrchestratorServer],
      name: `agent-orchestrator-smoke-${process.pid}`,
      skipSupervisor: true,
      beforeInstall: async (mockApp) => {
        app = mockApp;
      },
    });
    app = createdApp;
  });

  afterAll(async () => {
    await app?.destroy();
  });

  it('loads without starting the full app', async () => {
    expect(app).toBeTruthy();
  });

  it('registers collection definitions', async () => {
    const collections = [
      'agentLoopRuns',
      'agentLoopSteps',
      'agentLoopEvents',
      'orchestratorConfig',
      'orchestratorLogs',
      'agentExecutionSpans',
      'agentMemoryContexts',
      'agentHarnessProfiles',
      'agentHarnessProfileVersions',
      'agentLoopPatterns',
      'agentLoopActionApprovals',
      'agentLoopArtifacts',
      'agentLoopWorktrees',
      'agentLoopPathLocks',
      'agentLoopCircuitStates',
      'agentLoopUsageBuckets',
      'agentLoopControlSettings',
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

  it('has agentLoopRuns schema with required fields and indexes', async () => {
    const collection = app.db.getCollection('agentLoopRuns');
    expect(collection).toBeTruthy();

    const fields = {
      goal: 'text',
      status: 'string',
      runtimeVersion: 'string',
      recordMode: 'string',
      patternId: 'bigInt',
      pattern: 'belongsTo',
      userId: 'bigInt',
      policySnapshot: 'json',
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

    await ensureAgentOrchestratorIndexes(app.db);
    await ensureAgentOrchestratorIndexes(app.db);

    const indexes = (await app.db.sequelize
      .getQueryInterface()
      .showIndex(collection.getTableNameWithSchema())) as DatabaseIndex[];
    const fieldNames = (index: DatabaseIndex) => index.fields?.map((field) => field.attribute || field.name).join(',');

    expect(indexes.some((index) => fieldNames(index) === 'userId,status')).toBe(true);
    expect(
      indexes.some(
        (index) =>
          index.name === 'agent_loop_runs_pattern_id_trigger_key' &&
          index.unique === true &&
          fieldNames(index) === 'patternId,triggerKey',
      ),
    ).toBe(true);

    const indexNames = indexes.flatMap((index) => (index.name ? [index.name] : []));
    expect(new Set(indexNames).size).toBe(indexNames.length);
  });

  it('can create an agentLoopRun record', async () => {
    const repo = app.db.getRepository('agentLoopRuns');
    const run = await repo.create({
      values: {
        rootRunId: 'test-root',
        goal: 'Test goal',
        status: 'queued',
      },
    });
    expect(run.id).toBeTruthy();
    expect(run.goal).toBe('Test goal');
    expect(run.status).toBe('queued');
    expect(run.rootRunId).toBe('test-root');
  });

  it('can create agentLoopSteps with parent-child relationship', async () => {
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
