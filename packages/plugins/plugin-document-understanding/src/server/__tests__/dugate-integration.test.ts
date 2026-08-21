import { PipelineExecutor } from '../services/PipelineExecutor';
import { ExternalApiClient } from '../services/ExternalApiClient';
import { seedDugateEndpoints } from '../dugate-seed';
import { EndpointDef, PipelineDef, PipelineStepDef, JobState } from '../types';

function endpoint(overrides: Partial<EndpointDef> = {}): EndpointDef {
  return {
    id: 1,
    name: 'dugate-test',
    subpath: '/api/v1/docs/ingest',
    method: 'POST',
    fileInputMode: 'multipart',
    fileFieldName: 'files[]',
    maxFiles: 1,
    executionMode: 'sync',
    discriminatorField: 'mode',
    discriminatorValue: 'parse',
    syncQueryParam: 'sync',
    taskIdExtractPath: 'name',
    taskIdExtractRegex: 'operations/([^/]+)',
    pollResultSubpath: '/api/v1/operations/{taskId}',
    pollTaskIdField: 'id',
    pollResultField: 'result',
    pollStatusField: 'metadata.state',
    pollCompletedValue: 'SUCCEEDED',
    enabled: true,
    ...overrides,
  };
}

function pipelineWithStep(stepEndpoint: EndpointDef): PipelineDef {
  const step: PipelineStepDef = {
    id: 1,
    pipelineId: 1,
    endpointId: stepEndpoint.id,
    stepOrder: 1,
    name: 'call',
    outputAlias: 'result',
    inputMapping: {},
    onError: 'fail',
    retryCount: 0,
    endpoint: stepEndpoint,
  };
  return { id: 1, name: 'dugate-pipeline', enabled: true, steps: [step] };
}

describe('DUGate sync-202 fallback', () => {
  it('starts polling when a sync request returns 202 with an operation id', async () => {
    const jobsRepo = {
      create: vi.fn().mockResolvedValue({ id: 42, externalTaskIds: {} }),
      findOne: vi.fn().mockResolvedValue({ id: 42 }),
      update: vi.fn().mockResolvedValue([]),
    };
    const pipelinesRepo = { findOne: vi.fn().mockResolvedValue(pipelineWithStep(endpoint())) };
    const db = {
      getRepository: vi.fn((name: string) => (name === 'doc_understanding_pipelines' ? pipelinesRepo : jobsRepo)),
    };
    const apiClient = {
      call: vi.fn().mockResolvedValue({
        status: 202,
        data: { name: 'operations/op_123', done: false, metadata: { state: 'RUNNING' } },
      }),
    } as unknown as ExternalApiClient;
    const jobManager = { startPolling: vi.fn().mockResolvedValue(undefined) } as any;
    const executor = new PipelineExecutor(db as never, apiClient, jobManager, { error: vi.fn() }, 'node-a');

    const job = await executor.execute(1, { file_url: 'uploads/du-test/sample.txt' });
    expect(job.id).toBe(42);
    await vi.waitFor(() => expect(jobManager.startPolling).toHaveBeenCalled());

    // Polling started with the extracted operation id
    expect(jobManager.startPolling).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ name: 'dugate-test' }),
      'op_123',
    );
    expect(jobsRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({
          status: 'polling',
          externalTaskIds: { '1': 'op_123' },
        }),
      }),
    );
  });

  it('stores a 200 sync response directly as step result', async () => {
    const jobsRepo = {
      create: vi.fn().mockResolvedValue({ id: 43, externalTaskIds: {} }),
      findOne: vi.fn().mockResolvedValue({ id: 43 }),
      update: vi.fn().mockResolvedValue([]),
    };
    const pipelinesRepo = { findOne: vi.fn().mockResolvedValue(pipelineWithStep(endpoint())) };
    const db = {
      getRepository: vi.fn((name: string) => (name === 'doc_understanding_pipelines' ? pipelinesRepo : jobsRepo)),
    };
    const apiClient = {
      call: vi.fn().mockResolvedValue({
        status: 200,
        data: { done: true, result: { content: 'parsed', extracted_data: null } },
      }),
    } as unknown as ExternalApiClient;
    const jobManager = { startPolling: vi.fn() } as any;
    const executor = new PipelineExecutor(db as never, apiClient, jobManager, { error: vi.fn() }, 'node-a');

    await executor.execute(1, { file_url: 'uploads/du-test/sample.txt' });
    await vi.waitFor(() => expect(apiClient.call).toHaveBeenCalled());

    expect(jobManager.startPolling).not.toHaveBeenCalled();
    expect(jobsRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({
          status: 'completed',
          stepResults: { result: { done: true, result: { content: 'parsed', extracted_data: null } } },
        }),
      }),
    );
  });

  it('passes the discriminator into the request body', async () => {
    const client = new ExternalApiClient({
      baseUrl: 'http://dugate.local',
      authType: 'none',
      defaultTimeout: 1000,
      defaultRetries: 0,
      pollInterval: 1000,
      pollTimeout: 5000,
    });
    const requestSpy = vi
      .spyOn(client as any, 'client')
      .mockReturnValue({ request: vi.fn().mockResolvedValue({ status: 200, data: { ok: true }, headers: {} }) });

    // The discriminator merge happens before axios sends the request, so mock
    // the axios adapter and assert on what would be sent.
    const http = (client as any).client;
    http.request = vi.fn().mockResolvedValue({ status: 200, data: { ok: true }, headers: {} });

    await client.call({
      endpoint: endpoint({ fileInputMode: 'none' }),
      body: { output_format: 'md' },
    });

    const requestArg = http.request.mock.calls[0][0];
    expect(requestArg.data).toEqual({ output_format: 'md', mode: 'parse' });
    expect(requestArg.params).toEqual({ sync: 'true' });
    expect(requestArg.url).toBe('/api/v1/docs/ingest');
  });
});

describe('DUGate seed data', () => {
  function makeRepo() {
    const store: any[] = [];
    return {
      store,
      findOne: vi.fn(async ({ filter }: any) => store.find((r) => r.name === filter?.name) ?? null),
      create: vi.fn(async ({ values }: any) => {
        const record = { id: store.length + 1, ...values };
        store.push(record);
        return record;
      }),
      update: vi.fn(async ({ filterByTk, values }: any) => {
        const rec = store.find((r) => r.id === filterByTk);
        if (rec) Object.assign(rec, values);
      }),
      destroy: vi.fn(async ({ filter }: any) => {
        const idx = store.findIndex((r) => r.pipelineId === filter?.pipelineId);
        if (idx >= 0) store.splice(idx, 1);
      }),
    };
  }

  it('seeds endpoints, workflows and convenience pipelines', async () => {
    const endpointsRepo = makeRepo();
    const pipelinesRepo = makeRepo();
    const stepsRepo = makeRepo();
    const db = {
      getRepository: vi.fn((name: string) => {
        if (name === 'doc_understanding_endpoints') return endpointsRepo;
        if (name === 'doc_understanding_pipelines') return pipelinesRepo;
        if (name === 'doc_understanding_pipeline_steps') return stepsRepo;
        return { findOne: vi.fn() };
      }),
    };

    await seedDugateEndpoints(db as never);

    // 31 core endpoints + 3 workflows
    expect(endpointsRepo.store).toHaveLength(34);
    expect(endpointsRepo.store.filter((e) => e.subpath.includes('/workflows'))).toHaveLength(3);
    expect(endpointsRepo.store.find((e) => e.name === 'dugate-extract-invoice')?.discriminatorValue).toBe('invoice');
    expect(endpointsRepo.store.find((e) => e.name === 'dugate-ingest-parse')?.discriminatorValue).toBe('parse');
    expect(endpointsRepo.store.find((e) => e.name === 'dugate-workflow-disbursement')?.discriminatorField).toBe(
      'process',
    );

    expect(pipelinesRepo.store).toHaveLength(34);
    expect(stepsRepo.store).toHaveLength(34);
    const firstStep = stepsRepo.store[0];
    expect(firstStep).toMatchObject({ stepOrder: 1, outputAlias: 'result' });
  });

  it('is idempotent when run twice', async () => {
    const endpointsRepo = makeRepo();
    const pipelinesRepo = makeRepo();
    const stepsRepo = makeRepo();
    const db = {
      getRepository: vi.fn((name: string) => {
        if (name === 'doc_understanding_endpoints') return endpointsRepo;
        if (name === 'doc_understanding_pipelines') return pipelinesRepo;
        if (name === 'doc_understanding_pipeline_steps') return stepsRepo;
        return { findOne: vi.fn() };
      }),
    };

    await seedDugateEndpoints(db as never);
    await seedDugateEndpoints(db as never);

    expect(endpointsRepo.store).toHaveLength(34);
    expect(pipelinesRepo.store).toHaveLength(34);
  });
});
