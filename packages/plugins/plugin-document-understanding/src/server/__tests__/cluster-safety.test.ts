import { AsyncJobManager, pollLeaseMs } from '../services/AsyncJobManager';
import { ExternalApiClient } from '../services/ExternalApiClient';
import { PipelineExecutor } from '../services/PipelineExecutor';

function row(attributes: Record<string, unknown>) {
  return {
    id: attributes.id,
    get: (name: string) => attributes[name],
  };
}

function transactionDb(jobsRepo: Record<string, any>, pipelinesRepo?: Record<string, any>) {
  return {
    getRepository: vi.fn((name: string) =>
      name === 'doc_understanding_jobs' ? jobsRepo : pipelinesRepo ?? { findOne: vi.fn() },
    ),
    sequelize: {
      transaction: vi.fn(async (fn: (transaction: unknown) => Promise<void>) => fn({ LOCK: { UPDATE: 'UPDATE' } })),
    },
  };
}

describe('PipelineExecutor resume claim', () => {
  const pipeline = {
    id: 1,
    steps: [
      { stepOrder: 1, name: 'ocr', outputAlias: 'ocr', endpoint: { executionMode: 'polling' } },
      { stepOrder: 2, name: 'summarize', outputAlias: 'summary', endpoint: { executionMode: 'sync' } },
    ],
  };

  function createExecutor(jobAttributes: Record<string, unknown>) {
    const jobsRepo = {
      findOne: vi.fn().mockResolvedValue(row(jobAttributes)),
      update: vi.fn().mockResolvedValue([]),
    };
    const pipelinesRepo = { findOne: vi.fn().mockResolvedValue(pipeline) };
    const db = transactionDb(jobsRepo, pipelinesRepo);
    const executor = new PipelineExecutor(db as never, {} as never, {} as never, { error: vi.fn() }, 'node-a');
    const runSteps = vi.fn().mockResolvedValue(undefined);
    (executor as any).runSteps = runSteps;
    return { executor, jobsRepo, runSteps };
  }

  it('resumes a job that is still polling and claims ownership', async () => {
    const { executor, jobsRepo, runSteps } = createExecutor({
      id: 7,
      status: 'polling',
      pipelineId: 1,
      currentStep: 1,
      stepResults: {},
      input: { file: 'x' },
    });

    await executor.resumeFromStep(7, { text: 'parsed' });

    expect(jobsRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        filterByTk: 7,
        values: expect.objectContaining({
          status: 'running',
          ownedBy: 'node-a',
          stepResults: { ocr: { text: 'parsed' } },
        }),
      }),
    );
    expect(runSteps).toHaveBeenCalledTimes(1);
    expect(runSteps.mock.calls[0][3]).toBe(2);
  });

  it('does not resume a job that was already resumed by another node', async () => {
    const { executor, jobsRepo, runSteps } = createExecutor({
      id: 7,
      status: 'running',
      pipelineId: 1,
      currentStep: 1,
      stepResults: {},
      input: {},
    });

    await executor.resumeFromStep(7, { text: 'parsed' });

    expect(jobsRepo.update).not.toHaveBeenCalled();
    expect(runSteps).not.toHaveBeenCalled();
  });

  it('does not resume a completed job when a webhook is retried', async () => {
    const { executor, jobsRepo, runSteps } = createExecutor({
      id: 7,
      status: 'completed',
      pipelineId: 1,
      currentStep: 2,
      stepResults: {},
      input: {},
    });

    await executor.resumeFromStep(7, { text: 'parsed' });

    expect(jobsRepo.update).not.toHaveBeenCalled();
    expect(runSteps).not.toHaveBeenCalled();
  });
});

describe('AsyncJobManager orphan handling', () => {
  function createManager(jobsRepo: Record<string, any>, nodeId = 'node-a') {
    const db = transactionDb(jobsRepo);
    return new AsyncJobManager(
      db as never,
      {} as ExternalApiClient,
      { onJobComplete: vi.fn(), onJobError: vi.fn() },
      { warn: vi.fn() },
      nodeId,
    );
  }

  it('fails only jobs this node owned or whose lease expired', async () => {
    const update = vi.fn().mockResolvedValue([]);
    const manager = createManager({ update });

    await manager.failOrphanedActiveJobs();

    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0][0]).toEqual({
      filter: { status: { $in: ['pending', 'running'] }, ownedBy: 'node-a' },
      values: expect.objectContaining({ status: 'failed', error: 'Server restarted during execution' }),
    });
    expect(update.mock.calls[1][0].filter).toEqual({
      status: { $in: ['pending', 'running'] },
      $or: [{ leaseExpiresAt: { $lt: expect.any(Date) } }, { leaseExpiresAt: null }],
    });
    expect(update.mock.calls[1][0].values.completedAt).toBeInstanceOf(Date);
  });

  it('adopts an orphaned polling job whose lease expired', async () => {
    const expiredLease = new Date(Date.now() - 60_000);
    const jobsRepo = {
      find: vi.fn().mockResolvedValue([
        {
          id: 11,
          pipelineId: 1,
          currentStep: 1,
          externalTaskIds: { '1': 'task-9' },
          ownedBy: 'dead-node',
          leaseExpiresAt: expiredLease,
        },
      ]),
      findOne: vi
        .fn()
        .mockResolvedValue(row({ id: 11, status: 'polling', ownedBy: 'dead-node', leaseExpiresAt: expiredLease })),
      update: vi.fn().mockResolvedValue([]),
    };
    const pipelinesRepo = {
      findOne: vi.fn().mockResolvedValue({
        steps: [{ stepOrder: 1, endpoint: { executionMode: 'polling', pollInterval: 5000 } }],
      }),
    };
    const db = transactionDb(jobsRepo, pipelinesRepo);
    const manager = new AsyncJobManager(
      db as never,
      {} as ExternalApiClient,
      { onJobComplete: vi.fn(), onJobError: vi.fn() },
      { warn: vi.fn() },
      'node-a',
    );
    const startPolling = vi.spyOn(manager, 'startPolling').mockResolvedValue(undefined);

    await manager.adoptOrphanedPollingJobs();

    expect(jobsRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        filterByTk: 11,
        values: expect.objectContaining({ ownedBy: 'node-a' }),
      }),
    );
    expect(startPolling).toHaveBeenCalledWith(11, expect.objectContaining({ executionMode: 'polling' }), 'task-9');
  });

  it('leaves a polling job alone while another node holds a valid lease', async () => {
    const validLease = new Date(Date.now() + 60_000);
    const jobsRepo = {
      find: vi.fn().mockResolvedValue([
        {
          id: 12,
          pipelineId: 1,
          currentStep: 1,
          externalTaskIds: { '1': 'task-9' },
          ownedBy: 'node-b',
          leaseExpiresAt: validLease,
        },
      ]),
      findOne: vi
        .fn()
        .mockResolvedValue(row({ id: 12, status: 'polling', ownedBy: 'node-b', leaseExpiresAt: validLease })),
      update: vi.fn().mockResolvedValue([]),
    };
    const pipelinesRepo = {
      findOne: vi.fn().mockResolvedValue({
        steps: [{ stepOrder: 1, endpoint: { executionMode: 'polling', pollInterval: 5000 } }],
      }),
    };
    const db = transactionDb(jobsRepo, pipelinesRepo);
    const manager = new AsyncJobManager(
      db as never,
      {} as ExternalApiClient,
      { onJobComplete: vi.fn(), onJobError: vi.fn() },
      { warn: vi.fn() },
      'node-a',
    );
    const startPolling = vi.spyOn(manager, 'startPolling').mockResolvedValue(undefined);

    await manager.adoptOrphanedPollingJobs();

    expect(jobsRepo.update).not.toHaveBeenCalled();
    expect(startPolling).not.toHaveBeenCalled();
  });

  it('never adopts webhook-mode jobs because any node can serve the callback', async () => {
    const expiredLease = new Date(Date.now() - 60_000);
    const jobsRepo = {
      find: vi.fn().mockResolvedValue([
        {
          id: 13,
          pipelineId: 1,
          currentStep: 1,
          externalTaskIds: { '1': 'task-9' },
          ownedBy: 'dead-node',
          leaseExpiresAt: expiredLease,
        },
      ]),
      findOne: vi.fn(),
      update: vi.fn().mockResolvedValue([]),
    };
    const pipelinesRepo = {
      findOne: vi.fn().mockResolvedValue({
        steps: [{ stepOrder: 1, endpoint: { executionMode: 'webhook' } }],
      }),
    };
    const db = transactionDb(jobsRepo, pipelinesRepo);
    const manager = new AsyncJobManager(
      db as never,
      {} as ExternalApiClient,
      { onJobComplete: vi.fn(), onJobError: vi.fn() },
      { warn: vi.fn() },
      'node-a',
    );
    const startPolling = vi.spyOn(manager, 'startPolling').mockResolvedValue(undefined);

    await manager.adoptOrphanedPollingJobs();

    expect(jobsRepo.findOne).not.toHaveBeenCalled();
    expect(startPolling).not.toHaveBeenCalled();
  });

  it('computes polling leases with a floor above the poll interval', () => {
    expect(pollLeaseMs(5000)).toBe(60_000);
    expect(pollLeaseMs(60_000)).toBe(180_000);
    expect(pollLeaseMs(undefined)).toBe(60_000);
  });
});
