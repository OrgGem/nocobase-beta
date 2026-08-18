import type { Database } from '@nocobase/database';
import { describe, expect, it } from 'vitest';
import { HarnessProfileService } from '../services/HarnessProfileService';

type Row = Record<string, unknown>;

function readField(record: unknown, key: string) {
  const model = record as { get?: (name: string) => unknown; [key: string]: unknown };
  return typeof model?.get === 'function' ? model.get(key) : model?.[key];
}

function matches(row: Row, filter: Row) {
  return Object.entries(filter).every(([key, value]) => row[key] === value);
}

class MemoryRepository {
  private nextId: number;

  constructor(readonly rows: Row[] = []) {
    this.nextId = rows.reduce((maximum, row) => Math.max(maximum, Number(row.id) || 0), 0) + 1;
  }

  async findOne(options: Row) {
    if (options.filterByTk !== undefined) {
      return this.rows.find((row) => row.id === options.filterByTk) || null;
    }
    const filter = (options.filter as Row | undefined) || {};
    const matchesFilter = this.rows.filter((row) => matches(row, filter));
    if (options.sort && (options.sort as string[]).includes('-version')) {
      matchesFilter.sort((left, right) => Number(right.version) - Number(left.version));
    }
    return matchesFilter[0] || null;
  }

  async create(options: Row) {
    const row = { id: this.nextId++, ...((options.values as Row | undefined) || {}) };
    this.rows.push(row);
    return row;
  }

  async update(options: Row) {
    const values = (options.values as Row | undefined) || {};
    for (const row of this.rows) {
      if (options.filterByTk !== undefined && row.id === options.filterByTk) {
        Object.assign(row, values);
      }
    }
  }
}

function createService() {
  const profiles = new MemoryRepository([{ id: 1, tag: 'safe', enabled: true, schemaVersion: 1 }]);
  const versions = new MemoryRepository();
  const repositories = new Map([
    ['agentHarnessProfiles', profiles],
    ['agentHarnessProfileVersions', versions],
  ]);
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const database = {
    getRepository(name: string) {
      const repository = repositories.get(name);
      if (!repository) throw new Error(`Unexpected repository ${name}`);
      return repository;
    },
    sequelize: {
      async transaction<T>(callback: (value: typeof transaction) => Promise<T>) {
        return callback(transaction);
      },
    },
  };
  return {
    profiles,
    versions,
    service: new HarnessProfileService(database as unknown as Database),
  };
}

describe('HarnessProfileService', () => {
  it('creates sequential drafts, publishes atomically, and keeps snapshots immutable', async () => {
    const { profiles, versions, service } = createService();
    const firstDraft = await service.createDraft({
      profileId: 1,
      settings: { tools: { allow: ['read_file'], effects: { read_file: 'read' } } },
    });
    expect(firstDraft).toMatchObject({ profileId: 1, version: 1, status: 'draft' });

    const updatedDraft = await service.updateDraft(firstDraft.id, {
      tools: { allow: ['read_file', 'read_test'], effects: { read_file: 'read', read_test: 'read' } },
    });
    expect(updatedDraft.settings.tools.allow).toEqual(['read_file', 'read_test']);

    const published = await service.publish(firstDraft.id, 9);
    expect(published).toMatchObject({ version: 1, status: 'published', publishedById: 9 });
    expect(profiles.rows[0].currentVersionId).toBe(firstDraft.id);
    await expect(service.updateDraft(firstDraft.id, {})).rejects.toThrow('immutable');

    const runSnapshot = structuredClone(published.settings);
    const secondDraft = await service.createDraft({
      profileId: 1,
      settings: { tools: { deny: ['read_file'] } },
    });
    expect(secondDraft.version).toBe(2);
    expect(versions.rows).toHaveLength(2);

    const currentBeforePublish = await service.getPublishedByTag('safe');
    expect(currentBeforePublish?.version).toBe(1);
    expect(runSnapshot.tools.allow).toEqual(['read_file', 'read_test']);

    await service.publish(secondDraft.id, 10);
    const currentAfterPublish = await service.getPublishedByTag('safe');
    expect(currentAfterPublish?.version).toBe(2);
    expect(runSnapshot.tools.allow).toEqual(['read_file', 'read_test']);
  });

  it('returns validation errors without writing a draft', async () => {
    const { versions, service } = createService();
    expect(service.validate({ limits: { timeoutMs: -1 } }).success).toBe(false);
    await expect(service.createDraft({ profileId: 1, settings: { limits: { timeoutMs: -1 } } })).rejects.toThrow();
    expect(versions.rows).toHaveLength(0);
  });

  it('saveDraft keeps a single open draft and starts a new version after publish', async () => {
    const { versions, service } = createService();

    const first = await service.saveDraft({ profileId: 1, settings: { memory: { maxChars: 1000 } } });
    expect(first).toMatchObject({ version: 1, status: 'draft' });

    // The open draft is updated in place instead of accumulating another draft row.
    const updated = await service.saveDraft({ profileId: 1, settings: { memory: { maxChars: 2000 } } });
    expect(updated.id).toBe(first.id);
    expect(updated.settings.memory.maxChars).toBe(2000);
    expect(versions.rows).toHaveLength(1);

    await service.publish(first.id, 9);
    const next = await service.saveDraft({ profileId: 1, settings: { memory: { maxChars: 3000 } } });
    expect(next).toMatchObject({ version: 2, status: 'draft' });
    expect(versions.rows).toHaveLength(2);
  });

  it('createProfile publishes the first version atomically with the profile row', async () => {
    const { profiles, service } = createService();

    const { profile, version } = await service.createProfile({
      tag: 'strict',
      title: 'Strict policy',
      settings: { memory: { scopes: ['public'] } },
      publishedById: 9,
    });

    expect(readField(profile, 'tag')).toBe('strict');
    expect(version).toMatchObject({ version: 1, status: 'published', publishedById: 9 });
    const row = profiles.rows.find((item) => item.tag === 'strict');
    expect(row?.currentVersionId).toBe(version.id);

    // The published version is resolvable by tag immediately after create.
    const published = await service.getPublishedByTag('strict');
    expect(published?.version).toBe(1);
    expect(published?.settings.memory.scopes).toEqual(['public']);
  });

  it('rejects createProfile when settings fail validation', async () => {
    const { profiles, service } = createService();

    await expect(service.createProfile({ tag: 'broken', settings: { limits: { timeoutMs: -1 } } })).rejects.toThrow();
    expect(profiles.rows.find((item) => item.tag === 'broken')).toBeUndefined();
  });
});
