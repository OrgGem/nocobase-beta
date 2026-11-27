// SPDX-License-Identifier: Apache-2.0

import { PipelineExecutor } from '../services/PipelineExecutor';
import { ExternalApiClient } from '../services/ExternalApiClient';
import { seedDugateEndpoints } from '../dugate-seed';
import { EndpointDef, PipelineDef, PipelineStepDef } from '../types';

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
    protocolMode: 'legacy_rest',
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

describe('Legacy DUGate sync-202 fallback compatibility', () => {
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
    const jobManager = { startPolling: vi.fn().mockResolvedValue(undefined) };
    const executor = new PipelineExecutor(db as never, apiClient, jobManager as never, { error: vi.fn() }, 'node-a');

    const job = await executor.execute(1, { file_url: 'uploads/du-test/sample.txt' });
    expect(job.id).toBe(42);
    await vi.waitFor(() => expect(jobManager.startPolling).toHaveBeenCalled());

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
    const jobManager = { startPolling: vi.fn() };
    const executor = new PipelineExecutor(db as never, apiClient, jobManager as never, { error: vi.fn() }, 'node-a');

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
    const http = (client as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client;
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

describe('Canonical du-rework catalog seed & automatic legacy migration', () => {
  interface MockRecord {
    id: number;
    name?: string;
    pipelineId?: number;
    [key: string]: unknown;
  }

  function makeRepo(initial: MockRecord[] = []) {
    const store: MockRecord[] = [...initial];
    return {
      store,
      findOne: vi.fn(
        async ({ filter }: { filter?: { name?: string } }) => store.find((r) => r.name === filter?.name) ?? null,
      ),
      create: vi.fn(async ({ values }: { values: Record<string, unknown> }) => {
        const record: MockRecord = { id: store.length + 1, ...values };
        store.push(record);
        return record;
      }),
      update: vi.fn(async ({ filterByTk, values }: { filterByTk: number; values: Record<string, unknown> }) => {
        const rec = store.find((r) => r.id === filterByTk);
        if (rec) Object.assign(rec, values);
      }),
      destroy: vi.fn(async ({ filter }: { filter?: { pipelineId?: number } }) => {
        for (let i = store.length - 1; i >= 0; i -= 1) {
          if (store[i].pipelineId === filter?.pipelineId) store.splice(i, 1);
        }
      }),
    };
  }

  it('seeds all 36 canonical du-rework profiles across document-core, lc-checker, and example-review', async () => {
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

    const result = await seedDugateEndpoints(db as never);
    expect(result).toEqual({ endpoints: 36, pipelines: 36 });

    expect(endpointsRepo.store).toHaveLength(36);
    expect(endpointsRepo.store.find((e) => e.name === 'du-extract-invoice')).toMatchObject({
      subpath: '/api/v1/businesses/document-core/actions/extract',
      protocolMode: 'builtin_du',
      businessId: 'document-core',
      actionName: 'extract',
      discriminatorField: 'type',
      discriminatorValue: 'invoice',
    });
    expect(endpointsRepo.store.find((e) => e.name === 'du-transform-redact')?.discriminatorField).toBe('variant');
    expect(endpointsRepo.store.find((e) => e.name === 'du-lc-checker')).toMatchObject({
      subpath: '/api/v1/businesses/lc-checker/actions/lc-checker',
      businessId: 'lc-checker',
      actionName: 'lc-checker',
    });
    expect(endpointsRepo.store.find((e) => e.name === 'du-example-review')?.businessId).toBe('example-review');

    expect(pipelinesRepo.store).toHaveLength(36);
    expect(stepsRepo.store).toHaveLength(36);
  });

  it('upgrades pre-existing legacy dugate-* endpoints in-place and stays idempotent', async () => {
    const endpointsRepo = makeRepo([
      {
        id: 1,
        name: 'dugate-extract-invoice',
        subpath: '/api/v1/docs/extract',
        discriminatorField: 'type',
        discriminatorValue: 'invoice',
      },
      {
        id: 2,
        name: 'dugate-workflow-lc-checker',
        subpath: '/api/v1/docs/workflows',
        discriminatorField: 'process',
        discriminatorValue: 'lc-checker',
      },
    ]);
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

    expect(endpointsRepo.store).toHaveLength(36);
    expect(endpointsRepo.store.find((e) => e.id === 1)).toMatchObject({
      name: 'du-extract-invoice',
      subpath: '/api/v1/businesses/document-core/actions/extract',
      protocolMode: 'builtin_du',
    });
    expect(endpointsRepo.store.find((e) => e.id === 2)).toMatchObject({
      name: 'du-lc-checker',
      subpath: '/api/v1/businesses/lc-checker/actions/lc-checker',
      businessId: 'lc-checker',
    });
  });
});
