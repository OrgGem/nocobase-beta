import type { Database } from '@nocobase/database';
import { describe, expect, it } from 'vitest';
import { LoopPatternService } from '../services/LoopPatternService';

type Row = Record<string, unknown>;

class MemoryRepository {
  constructor(readonly rows: Row[] = []) {}

  async find(options: Row = {}) {
    const filter = (options.filter as Row | undefined) || {};
    return this.rows.filter((row) => Object.entries(filter).every(([key, value]) => row[key] === value));
  }

  async findOne(options: Row) {
    if (options.filterByTk !== undefined) {
      return this.rows.find((row) => String(row.id) === String(options.filterByTk)) || null;
    }
    return (await this.find(options))[0] || null;
  }
}

function pattern(values: Row = {}) {
  return {
    id: 1,
    key: 'nightly-report',
    title: 'Nightly report',
    goalTemplate: 'Summarize yesterday.',
    enabled: true,
    autonomyLevel: 'L1',
    triggerType: 'manual',
    leaderUsername: 'leader',
    makerUsernames: ['maker-a', 'maker-b'],
    verifierUsername: 'verifier',
    leaderHarnessTag: 'default',
    makerHarnessTag: 'default',
    verifierHarnessTag: 'safe',
    ...values,
  };
}

function createService(input: { patterns: Row[]; employeeHarnesses?: Record<string, unknown> }) {
  const repositories = new Map<string, MemoryRepository>([
    ['agentLoopPatterns', new MemoryRepository(input.patterns)],
    [
      'agentHarnessProfiles',
      new MemoryRepository([
        { id: 1, tag: 'default', enabled: true, currentVersionId: 1 },
        { id: 2, tag: 'safe', enabled: true, currentVersionId: 2 },
      ]),
    ],
    [
      'agentHarnessProfileVersions',
      new MemoryRepository([
        {
          id: 1,
          profileId: 1,
          version: 3,
          schemaVersion: 1,
          status: 'published',
          settings: { tools: { allow: ['read_file'] } },
        },
        {
          id: 2,
          profileId: 2,
          version: 1,
          schemaVersion: 1,
          status: 'published',
          settings: { tools: { allow: ['read_file'], deny: ['write_file'] } },
        },
      ]),
    ],
  ]);
  const database = {
    getRepository(name: string) {
      const repository = repositories.get(name);
      if (!repository) throw new Error(`Unexpected repository ${name}`);
      return repository;
    },
  };
  const employeeHarnesses = input.employeeHarnesses || {};
  return new LoopPatternService(
    database as unknown as Database,
    async (username: string) => employeeHarnesses[username],
    async () => ({ available: false }),
  );
}

describe('LoopPatternService compilation', () => {
  it('compiles a distinct harness snapshot for every maker', async () => {
    const service = createService({
      patterns: [pattern()],
      employeeHarnesses: {
        // Employee-level overrides differ per username, so reusing the first maker's
        // compilation would grant or deny the wrong tools for the second maker.
        'maker-b': { tools: { deny: ['read_file'], ask: ['run_tests'] } },
      },
    });

    const compiled = await service.compile(1);

    expect(Object.keys(compiled.makerHarnesses)).toEqual(['maker-a', 'maker-b']);
    expect(compiled.makerHarnesses['maker-a'].effective.tools.deny).toEqual([]);
    expect(compiled.makerHarnesses['maker-a'].effective.tools.allow).toContain('read_file');
    expect(compiled.makerHarnesses['maker-b'].effective.tools.deny).toEqual(['read_file']);
    expect(compiled.makerHarnesses['maker-b'].effective.tools.ask).toEqual(['run_tests']);
    expect(compiled.makerHarnesses['maker-a'].effective.sources).not.toContain('employee:maker-b');
    expect(compiled.makerHarnesses['maker-b'].effective.sources).toContain('employee:maker-b');
    expect(compiled.roleBindings).toMatchObject({
      leader: 'leader',
      makers: ['maker-a', 'maker-b'],
      verifier: 'verifier',
    });
  });

  it('falls back to the leader when a pattern declares no makers', async () => {
    const service = createService({ patterns: [pattern({ makerUsernames: [] })] });

    const compiled = await service.compile(1);

    // The worker iterates `roleBindings.makers`, so returning the raw empty array here made it run
    // zero makers while `makerHarnesses` held a leader snapshot: the whole execution phase was
    // skipped and the verifier only ever saw the leader's plan.
    expect(Object.keys(compiled.makerHarnesses)).toEqual(['leader']);
    expect(compiled.roleBindings.makers).toEqual(['leader']);
  });

  it('refuses to compile a disabled pattern', async () => {
    const service = createService({ patterns: [pattern({ enabled: false })] });
    await expect(service.compile(1)).rejects.toThrow('is disabled');
  });

  it('blocks L2 patterns when no worktree provider is available', async () => {
    const service = createService({
      patterns: [
        pattern({
          autonomyLevel: 'L2',
          repositoryKey: 'repo',
          repositoryRoot: '/srv/repo',
          actingOn: ['src/**'],
          policy: { harness: { isolation: { mode: 'worktree', requireWorktree: true } } },
        }),
      ],
    });

    await expect(service.compile(1)).rejects.toThrow('worktree provider');
  });
});
