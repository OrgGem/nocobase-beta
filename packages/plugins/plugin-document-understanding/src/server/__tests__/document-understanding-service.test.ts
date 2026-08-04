import { DocumentUnderstandingService } from '../services/DocumentUnderstandingService';

describe('DocumentUnderstandingService configuration exposure', () => {
  const config = {
    id: 1,
    baseUrl: 'https://processor.example.com',
    authType: 'bearer',
    authKey: 'super-secret-token',
    webhookSecret: 'webhook-secret',
    defaultTimeout: 30000,
    defaultRetries: 2,
    pollInterval: 5000,
    pollTimeout: 300000,
  };

  it('does not expose stored secrets to a browser caller', async () => {
    const db = {
      getRepository: () => ({ findOne: vi.fn().mockResolvedValue(config) }),
    };
    const service = new DocumentUnderstandingService({ logger: {} } as never, db as never);

    await expect(service.getConfigForClient()).resolves.toEqual({
      id: 1,
      baseUrl: 'https://processor.example.com',
      authType: 'bearer',
      authHeaderName: undefined,
      defaultTimeout: 30000,
      defaultRetries: 2,
      pollInterval: 5000,
      pollTimeout: 300000,
      hasAuthKey: true,
      hasWebhookSecret: true,
    });
  });

  it('keeps existing secrets when an update omits them', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const db = {
      getRepository: () => ({ findOne: vi.fn().mockResolvedValue(config), update }),
    };
    const service = new DocumentUnderstandingService({ logger: {} } as never, db as never);

    await service.updateConfig({ baseUrl: 'https://new-processor.example.com', authKey: '' });

    expect(update).toHaveBeenCalledWith({
      filterByTk: 1,
      values: { baseUrl: 'https://new-processor.example.com' },
    });
  });
});

function createExecutor(pipeline: Record<string, unknown>) {
  const jobsRepo = { create: vi.fn() };
  const db = {
    getRepository: vi.fn((name: string) =>
      name === 'doc_understanding_pipelines' ? { findOne: vi.fn().mockResolvedValue(pipeline) } : jobsRepo,
    ),
  };
  return { db, jobsRepo };
}

describe('Pipeline execution guards', () => {
  it('rejects a disabled pipeline before creating a job', async () => {
    const { db, jobsRepo } = createExecutor({ id: 1, enabled: false, steps: [] });
    const { PipelineExecutor } = await import('../services/PipelineExecutor');
    const executor = new PipelineExecutor(db as never, {} as never, {} as never, { error: vi.fn() });

    await expect(executor.execute(1, {})).rejects.toThrow('disabled');
    expect(jobsRepo.create).not.toHaveBeenCalled();
  });
});
