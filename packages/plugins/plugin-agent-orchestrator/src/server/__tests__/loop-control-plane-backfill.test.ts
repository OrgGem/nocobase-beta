import { describe, expect, it } from 'vitest';
import { backfillLoopControlPlaneData } from '../migrations/20260803010000-backfill-loop-control-plane-data';

type Row = Record<string, unknown>;

function matches(row: Row, filter: Row) {
  return Object.entries(filter).every(([key, value]) => row[key] === value);
}

class MemoryRepository {
  private nextId: number;

  constructor(readonly rows: Row[] = []) {
    this.nextId = rows.reduce((maximum, row) => Math.max(maximum, Number(row.id) || 0), 0) + 1;
  }

  async find(options: Row = {}) {
    const filter = (options.filter as Row | undefined) || {};
    return this.rows.filter((row) => matches(row, filter));
  }

  async findOne(options: Row) {
    const filter = (options.filter as Row | undefined) || {};
    return this.rows.find((row) => matches(row, filter)) || null;
  }

  async create(options: Row) {
    const values = { ...((options.values as Row | undefined) || {}) };
    const row = { id: this.nextId++, ...values };
    this.rows.push(row);
    return row;
  }

  async update(options: Row) {
    const filterByTk = options.filterByTk;
    const filter = (options.filter as Row | undefined) || null;
    const values = (options.values as Row | undefined) || {};
    for (const row of this.rows) {
      if ((filterByTk !== undefined && row.id === filterByTk) || (filter && matches(row, filter))) {
        Object.assign(row, values);
      }
    }
  }
}

function createDatabase() {
  const repositories = new Map<string, MemoryRepository>([
    [
      'agentHarnessProfiles',
      new MemoryRepository([
        { id: 1, tag: 'default', schemaVersion: 1, settings: { tools: { deny: ['shell'] } } },
        { id: 2, tag: 'draft-only', schemaVersion: 1, settings: { tools: { allow: ['read_file'] } } },
        {
          id: 3,
          tag: 'published-current',
          schemaVersion: 1,
          currentVersionId: 30,
          settings: { tools: { deny: ['legacy'] } },
        },
      ]),
    ],
    [
      'agentHarnessProfileVersions',
      new MemoryRepository([
        { id: 20, profileId: 2, version: 1, status: 'draft', settings: { tools: { allow: ['read_file'] } } },
        { id: 30, profileId: 3, version: 4, status: 'published', settings: { tools: { deny: ['published'] } } },
      ]),
    ],
    [
      'agentLoopRuns',
      new MemoryRepository([
        { id: 10, status: 'running', metadata: { source: 'legacy' }, lockedBy: 'worker-1' },
        { id: 11, status: 'succeeded', metadata: {} },
        {
          id: 12,
          rootRunId: 'loop-v2',
          runtimeVersion: 'control-plane-v2',
          recordMode: 'observed-execution',
          patternId: 7,
          status: 'queued',
          policySnapshot: { maxConcurrency: 1 },
          metadata: { source: 'control-plane' },
        },
        {
          id: 13,
          runtimeVersion: 'control-plane-v2',
          recordMode: 'observed-execution',
          status: 'planning',
          patternId: 7,
          policySnapshot: { maxConcurrency: 1 },
          planSource: 'legacy-planner',
        },
        {
          id: 14,
          runtimeVersion: 'control-plane-v2',
          recordMode: 'observed-execution',
          status: 'queued',
          patternId: 7,
          policySnapshot: { malformed: true },
        },
        {
          id: 15,
          runtimeVersion: 'legacy-plan-v1',
          recordMode: 'legacy-plan',
          status: 'blocked',
          metadata: { legacyStatus: 'running', legacyRuntimeRetired: true },
        },
      ]),
    ],
    [
      'agentLoopSteps',
      new MemoryRepository([
        { id: 20, runId: 10, status: 'running' },
        { id: 21, runId: 11, status: 'succeeded' },
        { id: 22, runId: 12, status: 'pending', runtimeVersion: 'control-plane-v2' },
      ]),
    ],
    ['agentLoopEvents', new MemoryRepository()],
    [
      'agentExecutionSpans',
      new MemoryRepository([
        { id: 30, metadata: { agentLoopRunId: '10' } },
        { id: 31, agentLoopRunId: 11, metadata: { agentLoopRunId: 10 } },
      ]),
    ],
    ['agentLoopControlSettings', new MemoryRepository()],
  ]);

  const database = {
    getRepository(name: string) {
      return repositories.get(name);
    },
    sequelize: {
      async transaction<T>(callback: (transaction: unknown) => Promise<T>) {
        return callback({});
      },
    },
  };

  return { database, repositories };
}

describe('Loop Control Plane data backfill', () => {
  it('publishes legacy harness settings and converts plan-era records safely', async () => {
    const { database, repositories } = createDatabase();

    await backfillLoopControlPlaneData(database);

    const profiles = repositories.get('agentHarnessProfiles')?.rows || [];
    const versions = repositories.get('agentHarnessProfileVersions')?.rows || [];
    expect(versions).toHaveLength(4);
    expect(versions).toContainEqual(
      expect.objectContaining({
        profileId: 1,
        version: 1,
        status: 'published',
      }),
    );
    expect(versions.find((version) => version.profileId === 1)?.settings).toMatchObject({
      tools: { deny: ['shell'] },
    });
    expect(versions).toContainEqual(
      expect.objectContaining({
        profileId: 2,
        version: 2,
        status: 'published',
      }),
    );
    expect(versions.find((version) => version.profileId === 2)?.settings).toMatchObject({
      tools: { allow: ['read_file'] },
    });
    expect(profiles.find((profile) => profile.id === 1)?.currentVersionId).toBeGreaterThan(30);
    expect(profiles.find((profile) => profile.id === 2)?.currentVersionId).toBeGreaterThan(30);
    expect(profiles.find((profile) => profile.id === 3)?.currentVersionId).toBe(30);
    expect(versions.find((version) => version.id === 20)?.status).toBe('draft');

    const runs = repositories.get('agentLoopRuns')?.rows || [];
    expect(runs[0]).toMatchObject({
      runtimeVersion: 'legacy-plan-v1',
      recordMode: 'legacy-plan',
      status: 'blocked',
      lockedBy: null,
      lockedUntil: null,
      metadata: {
        source: 'legacy',
        legacyStatus: 'running',
        legacyRuntimeRetired: true,
      },
    });
    expect(runs[1]).toMatchObject({
      runtimeVersion: 'legacy-plan-v1',
      recordMode: 'legacy-plan',
      status: 'succeeded',
      metadata: {
        legacyStatus: 'succeeded',
        legacyRuntimeRetired: true,
      },
    });
    expect(runs[2]).toMatchObject({
      runtimeVersion: 'control-plane-v2',
      recordMode: 'observed-execution',
      status: 'queued',
      patternId: 7,
      policySnapshot: { maxConcurrency: 1 },
      metadata: { source: 'control-plane' },
    });
    expect(runs[3]).toMatchObject({
      runtimeVersion: 'legacy-plan-v1',
      recordMode: 'legacy-plan',
      status: 'blocked',
      blockedReason: 'The legacy plan runtime was retired. This historical run is read-only.',
      metadata: { legacyStatus: 'planning', legacyRuntimeRetired: true },
    });
    expect(runs[4]).toMatchObject({
      runtimeVersion: 'legacy-plan-v1',
      recordMode: 'legacy-plan',
      status: 'blocked',
      metadata: { legacyStatus: 'queued', legacyRuntimeRetired: true },
    });
    expect(runs[5]).toMatchObject({
      runtimeVersion: 'legacy-plan-v1',
      recordMode: 'legacy-plan',
      status: 'blocked',
      metadata: { legacyStatus: 'running', legacyRuntimeRetired: true },
    });

    expect(repositories.get('agentLoopSteps')?.rows).toEqual([
      { id: 20, runId: 10, status: 'running', runtimeVersion: 'legacy-plan-v1' },
      { id: 21, runId: 11, status: 'succeeded', runtimeVersion: 'legacy-plan-v1' },
      { id: 22, runId: 12, status: 'pending', runtimeVersion: 'control-plane-v2' },
    ]);
    expect(repositories.get('agentLoopEvents')?.rows).toHaveLength(3);
    expect(repositories.get('agentLoopEvents')?.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 10, type: 'legacy_runtime_retired', status: 'blocked' }),
        expect.objectContaining({ runId: 13, type: 'legacy_runtime_retired', status: 'blocked' }),
        expect.objectContaining({ runId: 14, type: 'legacy_runtime_retired', status: 'blocked' }),
      ]),
    );

    expect(repositories.get('agentExecutionSpans')?.rows).toMatchObject([
      { id: 30, agentLoopRunId: 10 },
      { id: 31, agentLoopRunId: 11 },
    ]);
    expect(repositories.get('agentLoopControlSettings')?.rows).toMatchObject([
      { key: 'global', acceptNewRuns: true, state: 'running', globalMaxConcurrency: 5 },
    ]);
  });

  it('is idempotent for profile versions, retirement events, and global control', async () => {
    const { database, repositories } = createDatabase();

    await backfillLoopControlPlaneData(database);
    const versionsAfterFirstRun = structuredClone(repositories.get('agentHarnessProfileVersions')?.rows || []);
    const runsAfterFirstRun = structuredClone(repositories.get('agentLoopRuns')?.rows || []);
    const eventsAfterFirstRun = structuredClone(repositories.get('agentLoopEvents')?.rows || []);
    const controlsAfterFirstRun = structuredClone(repositories.get('agentLoopControlSettings')?.rows || []);

    await backfillLoopControlPlaneData(database);

    expect(repositories.get('agentHarnessProfileVersions')?.rows).toEqual(versionsAfterFirstRun);
    expect(repositories.get('agentLoopRuns')?.rows).toEqual(runsAfterFirstRun);
    expect(repositories.get('agentLoopEvents')?.rows).toEqual(eventsAfterFirstRun);
    expect(repositories.get('agentLoopControlSettings')?.rows).toEqual(controlsAfterFirstRun);
  });
});
