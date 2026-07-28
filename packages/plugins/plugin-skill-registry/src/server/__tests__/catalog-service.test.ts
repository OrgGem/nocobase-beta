import { isRecord } from '../contracts/types';
import { CatalogService } from '../services/catalog-service';
import type { RegistryModel } from '../services/model-values';
import type { PublicCursorAnchor } from '../services/public-cursor';
import type { RegistryDatabase, RegistryRepository } from '../services/repository-types';

function model(values: Record<string, unknown>): RegistryModel {
  return { get: (attribute: string) => values[attribute] };
}

function timestamp(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  return typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : Number.NaN;
}

function nestedAfter(filter: unknown, idOperator: '$gt' | '$lt'): PublicCursorAnchor | undefined {
  if (!isRecord(filter) || !Array.isArray(filter.$and) || filter.$and.length < 2) {
    return undefined;
  }
  const keyset = filter.$and[1];
  if (!isRecord(keyset) || !Array.isArray(keyset.$or) || keyset.$or.length < 2) {
    return undefined;
  }
  const earlier = keyset.$or[0];
  const tie = keyset.$or[1];
  if (!isRecord(earlier) || !isRecord(earlier.publishedAt) || !isRecord(tie) || !Array.isArray(tie.$and)) {
    return undefined;
  }
  const publishedAt = earlier.publishedAt.$lt;
  const idClause = tie.$and[1];
  if (!(publishedAt instanceof Date) || !isRecord(idClause) || !isRecord(idClause.id)) {
    return undefined;
  }
  const id = idClause.id[idOperator];
  return typeof id === 'string' || typeof id === 'number'
    ? { publishedAt: publishedAt.toISOString(), id: String(id) }
    : undefined;
}

function baseFilter(filter: unknown): Record<string, unknown> {
  if (isRecord(filter) && Array.isArray(filter.$and) && isRecord(filter.$and[0])) {
    return filter.$and[0];
  }
  return isRecord(filter) ? filter : {};
}

function pageLimit(options: Record<string, unknown>): number {
  return typeof options.limit === 'number' ? options.limit : 100;
}

describe('CatalogService keyset pagination', () => {
  it('continues the public catalog without duplicates when rows before the cursor are inserted or deleted', async () => {
    let packageRows = [5, 4, 3, 2, 1].map((position) =>
      model({
        id: `package-${position}`,
        namespace: 'acme',
        slug: `skill-${position}`,
        displayName: `Skill ${position}`,
        description: '',
        tags: ['report'],
        downloadCount: 0,
        publishedAt: new Date(`2026-07-${20 + position}T00:00:00.000Z`),
      }),
    );
    const versionRows = [5, 4, 3, 2, 1].map((position) =>
      model({
        id: `version-${position}`,
        packageId: `package-${position}`,
        version: `${position}.0.0`,
        channel: 'stable',
        status: 'published',
        runtime: 'node',
        artifactDigest: `sha256:${String(position).repeat(64)}`,
        compatibility: {},
        publishedAt: new Date(`2026-07-${20 + position}T00:00:00.000Z`),
      }),
    );
    const packageFind = vi.fn(async (options: Record<string, unknown>) => {
      const after = nestedAfter(options.filter, '$gt');
      return [...packageRows]
        .sort((left, right) => {
          const dateOrder = timestamp(right.get('publishedAt')) - timestamp(left.get('publishedAt'));
          return dateOrder || String(left.get('id')).localeCompare(String(right.get('id')));
        })
        .filter((row) => {
          if (!after) {
            return true;
          }
          const rowTimestamp = timestamp(row.get('publishedAt'));
          const anchorTimestamp = timestamp(after.publishedAt);
          return (
            rowTimestamp < anchorTimestamp || (rowTimestamp === anchorTimestamp && String(row.get('id')) > after.id)
          );
        })
        .slice(0, pageLimit(options));
    });
    const versionFind = vi.fn(async (options: Record<string, unknown>) => {
      const filter = baseFilter(options.filter);
      const packageFilter = filter.packageId;
      if (!isRecord(packageFilter) || !Array.isArray(packageFilter.$in)) {
        return [];
      }
      const ids = new Set(packageFilter.$in.filter((id): id is string => typeof id === 'string'));
      return versionRows.filter((row) => ids.has(String(row.get('packageId'))));
    });
    const database: RegistryDatabase = {
      getRepository(name: string): RegistryRepository {
        return (name === 'skillRegistryPackages'
          ? { find: packageFind }
          : { find: versionFind }) as unknown as RegistryRepository;
      },
    };
    const service = new CatalogService(database);

    const first = await service.list({ channel: 'stable', limit: 2 });

    expect(first.rows.map((row) => row.name)).toEqual(['acme/skill-5', 'acme/skill-4']);
    expect(first.nextAnchor).toEqual({ publishedAt: '2026-07-24T00:00:00.000Z', id: 'package-4' });

    packageRows = packageRows.filter((row) => row.get('id') !== 'package-4');
    packageRows.push(
      model({
        id: 'package-6',
        namespace: 'acme',
        slug: 'skill-6',
        displayName: 'Skill 6',
        description: '',
        tags: ['report'],
        downloadCount: 0,
        publishedAt: new Date('2026-07-26T00:00:00.000Z'),
      }),
    );
    versionRows.push(
      model({
        id: 'version-6',
        packageId: 'package-6',
        version: '6.0.0',
        channel: 'stable',
        status: 'published',
        runtime: 'node',
        artifactDigest: `sha256:${'6'.repeat(64)}`,
        compatibility: {},
        publishedAt: new Date('2026-07-26T00:00:00.000Z'),
      }),
    );

    const second = await service.list({ channel: 'stable', limit: 2, after: first.nextAnchor || undefined });

    expect(second.rows.map((row) => row.name)).toEqual(['acme/skill-3', 'acme/skill-2']);
    expect(packageFind.mock.calls.every(([options]) => !Object.prototype.hasOwnProperty.call(options, 'offset'))).toBe(
      true,
    );
    expect(versionFind).toHaveBeenCalled();
    expect(
      versionFind.mock.calls.every(
        ([options]) => typeof options.limit === 'number' && options.limit > 0 && options.limit <= 500,
      ),
    ).toBe(true);
  });

  it('uses the stable-version pointer and bounded one-row lookups for packages without a pointer', async () => {
    const packageRows = [
      model({
        id: 'package-1',
        namespace: 'acme',
        slug: 'pointed',
        displayName: 'Pointed',
        description: '',
        tags: [],
        downloadCount: 0,
        latestStableVersionId: 'version-1',
        publishedAt: new Date('2026-07-25T00:00:00.000Z'),
      }),
      model({
        id: 'package-2',
        namespace: 'acme',
        slug: 'fallback',
        displayName: 'Fallback',
        description: '',
        tags: [],
        downloadCount: 0,
        publishedAt: new Date('2026-07-24T00:00:00.000Z'),
      }),
    ];
    const pointedVersion = model({
      id: 'version-1',
      packageId: 'package-1',
      version: '2.0.0',
      channel: 'stable',
      status: 'published',
      runtime: 'node',
      artifactDigest: `sha256:${'1'.repeat(64)}`,
      compatibility: {},
      publishedAt: new Date('2026-07-25T00:00:00.000Z'),
    });
    const fallbackVersion = model({
      id: 'version-2',
      packageId: 'package-2',
      version: '1.0.0',
      channel: 'stable',
      status: 'published',
      runtime: 'python',
      artifactDigest: `sha256:${'2'.repeat(64)}`,
      compatibility: {},
      publishedAt: new Date('2026-07-24T00:00:00.000Z'),
    });
    const packageFind = vi.fn().mockResolvedValue(packageRows);
    const versionFind = vi.fn().mockResolvedValue([pointedVersion]);
    const versionFindOne = vi.fn(async (options: Record<string, unknown>) => {
      const filter = isRecord(options.filter) ? options.filter : {};
      return filter.packageId === 'package-2' ? fallbackVersion : null;
    });
    const database: RegistryDatabase = {
      getRepository(name: string): RegistryRepository {
        return (name === 'skillRegistryPackages'
          ? { find: packageFind }
          : { find: versionFind, findOne: versionFindOne }) as unknown as RegistryRepository;
      },
    };
    const service = new CatalogService(database);

    const page = await service.list({ channel: 'stable', limit: 2 });

    expect(page.rows.map((row) => `${row.name}@${row.latest.version}`)).toEqual([
      'acme/pointed@2.0.0',
      'acme/fallback@1.0.0',
    ]);
    expect(versionFind).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { id: { $in: ['version-1'] }, channel: 'stable', status: 'published' },
        fields: expect.arrayContaining(['packageId', 'version', 'artifactDigest', 'publishedAt']),
        limit: 1,
      }),
    );
    expect(versionFindOne).toHaveBeenCalledOnce();
    expect(versionFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { packageId: 'package-2', channel: 'stable', status: 'published' },
        fields: expect.arrayContaining(['packageId', 'version', 'artifactDigest', 'publishedAt']),
      }),
    );
  });

  it('keeps an explicit version inside the requested channel', async () => {
    const packageRecord = model({
      id: 'package-1',
      namespace: 'acme',
      slug: 'report',
      visibility: 'public',
      status: 'published',
    });
    const betaVersion = model({
      id: 'version-beta',
      packageId: 'package-1',
      version: '1.0.0',
      channel: 'beta',
      status: 'published',
    });
    const packageFindOne = vi.fn().mockResolvedValue(packageRecord);
    const versionFindOne = vi.fn(async (options: Record<string, unknown>) => {
      const filter = isRecord(options.filter) ? options.filter : {};
      return filter.channel === 'beta' ? betaVersion : null;
    });
    const database: RegistryDatabase = {
      getRepository(name: string): RegistryRepository {
        return (name === 'skillRegistryPackages'
          ? { findOne: packageFindOne }
          : { findOne: versionFindOne }) as unknown as RegistryRepository;
      },
    };
    const service = new CatalogService(database);

    await expect(service.resolveVersion('acme/report', '1.0.0', 'stable')).rejects.toMatchObject({
      code: 'VERSION_NOT_FOUND',
      status: 404,
    });
    await expect(service.resolveVersion('acme/report', '1.0.0', 'beta')).resolves.toEqual({
      packageRecord,
      versionRecord: betaVersion,
    });
    expect(versionFindOne).toHaveBeenNthCalledWith(1, {
      filter: { packageId: 'package-1', version: '1.0.0', channel: 'stable', status: 'published' },
    });
  });

  it('continues version history from a deleted anchor while ignoring newer inserts', async () => {
    let versionRows = [5, 4, 3, 2, 1].map((position) =>
      model({
        id: position,
        packageId: 'package-1',
        version: `${position}.0.0`,
        publishedAt: new Date(`2026-07-${20 + position}T00:00:00.000Z`),
      }),
    );
    const versionFind = vi.fn(async (options: Record<string, unknown>) => {
      const after = nestedAfter(options.filter, '$lt');
      return [...versionRows]
        .sort((left, right) => {
          const dateOrder = timestamp(right.get('publishedAt')) - timestamp(left.get('publishedAt'));
          return dateOrder || String(right.get('id')).localeCompare(String(left.get('id')));
        })
        .filter((row) => {
          if (!after) {
            return true;
          }
          const rowTimestamp = timestamp(row.get('publishedAt'));
          const anchorTimestamp = timestamp(after.publishedAt);
          return (
            rowTimestamp < anchorTimestamp || (rowTimestamp === anchorTimestamp && String(row.get('id')) < after.id)
          );
        })
        .slice(0, pageLimit(options));
    });
    const database: RegistryDatabase = {
      getRepository: () => ({ find: versionFind }) as unknown as RegistryRepository,
    };
    const service = new CatalogService(database);
    const packageRecord = model({ id: 'package-1' });

    const first = await service.listVersions(packageRecord, 'stable', 2);
    expect(first.rows.map((row) => row.get('version'))).toEqual(['5.0.0', '4.0.0']);
    expect(first.nextAnchor).toEqual({ publishedAt: '2026-07-24T00:00:00.000Z', id: '4' });

    versionRows = versionRows.filter((row) => row.get('id') !== 4);
    versionRows.push(
      model({
        id: 6,
        packageId: 'package-1',
        version: '6.0.0',
        publishedAt: new Date('2026-07-26T00:00:00.000Z'),
      }),
    );

    const second = await service.listVersions(packageRecord, 'stable', 2, first.nextAnchor || undefined);
    expect(second.rows.map((row) => row.get('version'))).toEqual(['3.0.0', '2.0.0']);
    expect(versionFind.mock.calls.every(([options]) => !Object.prototype.hasOwnProperty.call(options, 'offset'))).toBe(
      true,
    );
  });
});
