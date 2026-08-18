import type { Database } from '@nocobase/database';
import { describe, expect, it, vi } from 'vitest';
import { compileHarness } from '../services/HarnessCompiler';
import type { CompiledPatternSnapshot, HarnessSnapshot } from '../services/LoopPatternService';
import type { LoopPatternService } from '../services/LoopPatternService';
import { LoopTriggerService } from '../services/LoopTriggerService';

type Row = Record<string, unknown>;

class MemoryRepository {
  private nextId: number;

  constructor(readonly rows: Row[] = []) {
    this.nextId = rows.reduce((maximum, row) => Math.max(maximum, Number(row.id) || 0), 0) + 1;
  }

  async findOne(options: Row = {}) {
    if (options.filterByTk !== undefined) return this.rows.find((row) => row.id === options.filterByTk) || null;
    const filter = (options.filter as Row | undefined) || {};
    return this.rows.find((row) => Object.entries(filter).every(([key, value]) => row[key] === value)) || null;
  }

  async create(options: Row) {
    const row = { id: this.nextId++, ...((options.values as Row | undefined) || {}) };
    this.rows.push(row);
    return row;
  }
}

function createDatabase(repositories: Map<string, MemoryRepository>) {
  return {
    getRepository(name: string) {
      const repository = repositories.get(name);
      if (!repository) throw new Error(`Unexpected repository ${name}`);
      return repository;
    },
    sequelize: {
      transaction<T>(callback: (transaction: unknown) => Promise<T>) {
        return callback({});
      },
    },
  } as unknown as Database;
}

function harnessAt(tag: string, version: number): HarnessSnapshot {
  return {
    tag,
    versionId: version * 10,
    version,
    schemaVersion: 1,
    effective: compileHarness([{ source: 'test', settings: {} }]),
  };
}

function compiledSnapshot(): CompiledPatternSnapshot {
  return {
    pattern: {
      key: 'nightly-release',
      triggerType: 'cron',
      goalTemplate: 'Ship the nightly release',
      autonomyLevel: 'L1',
      repositoryKey: '',
      repositoryRoot: '',
      baseRef: '',
      actingOn: [],
    } as unknown as CompiledPatternSnapshot['pattern'],
    roleBindings: { leader: 'lead', makers: ['maker-one'], verifier: 'check' },
    leaderHarness: harnessAt('strict', 3),
    makerHarnesses: { 'maker-one': harnessAt('default', 1) },
    verifierHarness: harnessAt('strict', 3),
    policy: {} as unknown as CompiledPatternSnapshot['policy'],
  };
}

function setup(compiled: CompiledPatternSnapshot) {
  const repositories = new Map<string, MemoryRepository>([
    [
      'agentLoopControlSettings',
      new MemoryRepository([{ id: 1, key: 'global', state: 'running', acceptNewRuns: true, globalMaxConcurrency: 5 }]),
    ],
    ['agentLoopRuns', new MemoryRepository()],
    ['agentLoopEvents', new MemoryRepository()],
  ]);
  const patterns = { compile: vi.fn(async () => compiled) } as unknown as LoopPatternService;
  return {
    repositories,
    service: new LoopTriggerService(createDatabase(repositories), patterns),
  };
}

describe('LoopTriggerService.enqueue harness audit', () => {
  it('records one harness_applied audit event per role when a run is queued', async () => {
    const { repositories, service } = setup(compiledSnapshot());

    const result = await service.enqueue({
      patternId: 1,
      triggerType: 'manual',
      triggerKey: 'manual-1',
      userId: 7,
      goal: 'Ship the feature',
    });

    expect(result.created).toBe(true);
    expect(repositories.get('agentLoopRuns')?.rows[0]).toMatchObject({
      status: 'queued',
      leaderUsername: 'lead',
      verifierUsername: 'check',
    });

    const events = repositories.get('agentLoopEvents')?.rows || [];
    expect(events.filter((event) => event.type === 'run_queued')).toHaveLength(1);
    const applied = events.filter((event) => event.type === 'harness_applied');
    expect(applied.map((event) => event.title)).toEqual([
      'Harness strict@v3 applied to leader',
      'Harness default@v1 applied to maker',
      'Harness strict@v3 applied to verifier',
    ]);
    expect(applied[0]).toMatchObject({
      runId: 1,
      status: 'queued',
      actorType: 'user',
      actorIdentity: '7',
      correlationKey: 'harness:leader:lead',
      payload: { role: 'leader', username: 'lead', tag: 'strict', version: 3, versionId: 30, schemaVersion: 1 },
    });
    expect(applied[1]).toMatchObject({ correlationKey: 'harness:maker:maker-one' });
    expect(applied[2]).toMatchObject({ correlationKey: 'harness:verifier:check' });
  });

  it('skips roles whose harness snapshot is missing', async () => {
    const snapshot = compiledSnapshot();
    snapshot.makerHarnesses = {};
    const { repositories, service } = setup(snapshot);

    await service.enqueue({
      patternId: 1,
      triggerType: 'manual',
      triggerKey: 'manual-2',
      goal: 'Ship it',
    });

    const applied = (repositories.get('agentLoopEvents')?.rows || []).filter(
      (event) => event.type === 'harness_applied',
    );
    expect(applied).toHaveLength(2);
    expect(applied.map((event) => (event.payload as Row).role)).toEqual(['leader', 'verifier']);
  });
});
