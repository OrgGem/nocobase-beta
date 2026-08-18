import type { RegistryPublicPackage } from '../contracts/types';
import { RegistryError } from '../contracts/errors';
import { getString, type RegistryModel } from './model-values';
import type { PublicCursorAnchor } from './public-cursor';
import type { RegistryDatabase } from './repository-types';

export interface CatalogPage<T> {
  rows: T[];
  nextAnchor: PublicCursorAnchor | null;
}

const CATALOG_SCAN_PAGE_SIZE = 100;
const CATALOG_SCAN_LIMIT = 500;
const LATEST_VERSION_FIELDS = [
  'id',
  'packageId',
  'version',
  'channel',
  'runtime',
  'entrypoint',
  'manifestDigest',
  'artifactDigest',
  'registrySignature',
  'signatureKeyId',
  'compatibility',
  'publishedAt',
];

function modelId(model: RegistryModel): string {
  return getString(model, 'id');
}

function splitPackageName(value: string): { namespace: string; slug: string } {
  const [namespace, slug, extra] = value.trim().split('/');
  if (!namespace || !slug || extra) {
    throw new RegistryError('PACKAGE_NOT_FOUND', 404, 'Package was not found.');
  }
  return { namespace, slug };
}

function tags(model: RegistryModel): string[] {
  const value = model.get('tags');
  return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string') : [];
}

function publicVersion(model: RegistryModel) {
  return {
    version: getString(model, 'version'),
    channel: getString(model, 'channel'),
    artifactDigest: getString(model, 'artifactDigest'),
  };
}

function cursorAnchor(model: RegistryModel): PublicCursorAnchor {
  const publishedAt = model.get('publishedAt');
  let timestamp: number;
  if (publishedAt instanceof Date) {
    timestamp = publishedAt.getTime();
  } else if (typeof publishedAt === 'string' || typeof publishedAt === 'number') {
    timestamp = new Date(publishedAt).getTime();
  } else {
    timestamp = Number.NaN;
  }
  const id = modelId(model);
  if (!Number.isFinite(timestamp) || !id) {
    throw new RegistryError('INTERNAL_ERROR', 500, 'An internal Skill Registry error occurred.');
  }
  return { publishedAt: new Date(timestamp).toISOString(), id };
}

function afterFilter(
  filter: Record<string, unknown>,
  after: PublicCursorAnchor | undefined,
  idDirection: 'ascending' | 'descending',
): Record<string, unknown> {
  if (!after) {
    return filter;
  }
  const publishedAt = new Date(after.publishedAt);
  const idOperator = idDirection === 'ascending' ? '$gt' : '$lt';
  const numericId = /^\d+$/.test(after.id) ? Number(after.id) : Number.NaN;
  const filterId = Number.isSafeInteger(numericId) ? numericId : after.id;
  return {
    $and: [
      filter,
      {
        $or: [{ publishedAt: { $lt: publishedAt } }, { $and: [{ publishedAt }, { id: { [idOperator]: filterId } }] }],
      },
    ],
  };
}

export class CatalogService {
  constructor(private readonly database: RegistryDatabase) {}

  private async sharedPackageIds(userId: string): Promise<string[]> {
    const shares = await this.database.getRepository('skillRegistryPackageShares').find({
      filter: { userId },
    });
    return shares.map((share) => getString(share, 'packageId'));
  }

  private baseFilter(userId?: string): Record<string, unknown> {
    if (!userId) {
      return { visibility: 'public', status: 'published' };
    }
    const sharedIds = this.sharedPackageIds(userId);
    return {
      status: 'published',
      $or: [{ visibility: 'public' }, { ownerId: userId }, { visibility: 'shared', id: { $in: sharedIds } }],
    };
  }

  async list(input: {
    q?: string;
    tag?: string;
    runtime?: string;
    channel?: string;
    limit: number;
    after?: PublicCursorAnchor;
    userId?: string;
  }): Promise<CatalogPage<RegistryPublicPackage>> {
    const packagesRepository = this.database.getRepository('skillRegistryPackages');
    const channel = input.channel || 'stable';
    const sharedIds = input.userId ? await this.sharedPackageIds(input.userId) : [];
    const baseFilter: Record<string, unknown> = input.userId
      ? {
          status: 'published',
          $or: [{ visibility: 'public' }, { ownerId: input.userId }, { visibility: 'shared', id: { $in: sharedIds } }],
        }
      : { visibility: 'public', status: 'published' };

    if (input.q) {
      const query = input.q.trim();
      const clauses: Record<string, unknown>[] = [
        { namespace: { $includes: query } },
        { slug: { $includes: query } },
        { displayName: { $includes: query } },
        { description: { $includes: query } },
      ];
      const [namespacePart, slugPart] = query.split('/');
      if (namespacePart && slugPart) {
        clauses.push({ $and: [{ namespace: { $includes: namespacePart } }, { slug: { $includes: slugPart } }] });
      }
      const accessOr = baseFilter.$or as Record<string, unknown>[];
      baseFilter.$and = [{ status: baseFilter.status }, { $or: accessOr }, { $or: clauses }];
      delete baseFilter.$or;
      delete baseFilter.status;
    }

    const results: Array<{ row: RegistryPublicPackage; anchor: PublicCursorAnchor }> = [];
    let scanAnchor = input.after;
    let scanned = 0;
    let exhausted = false;
    while (results.length <= input.limit && scanned < CATALOG_SCAN_LIMIT) {
      const pageSize = Math.min(CATALOG_SCAN_PAGE_SIZE, CATALOG_SCAN_LIMIT - scanned);
      const page = await packagesRepository.find({
        filter: afterFilter(baseFilter, scanAnchor, 'ascending'),
        sort: ['-publishedAt', 'id'],
        limit: pageSize,
      });
      if (!page.length) {
        exhausted = true;
        break;
      }
      const latestByPackage = await this.findLatestVersions(page, channel);
      for (const packageRecord of page) {
        scanAnchor = cursorAnchor(packageRecord);
        scanned += 1;
        const version = latestByPackage.get(modelId(packageRecord));
        if (!version) {
          continue;
        }
        const packageTags = tags(packageRecord);
        if (input.tag && !packageTags.includes(input.tag)) {
          continue;
        }
        if (input.runtime && getString(version, 'runtime') !== input.runtime) {
          continue;
        }
        results.push({
          anchor: scanAnchor,
          row: {
            name: `${getString(packageRecord, 'namespace')}/${getString(packageRecord, 'slug')}`,
            displayName: getString(packageRecord, 'displayName'),
            description: getString(packageRecord, 'description'),
            tags: packageTags,
            latest: publicVersion(version),
            compatibility: (version.get('compatibility') || {}) as RegistryPublicPackage['compatibility'],
            downloads: Number(packageRecord.get('downloadCount') || 0),
          },
        });
        if (results.length > input.limit) {
          break;
        }
      }
      if (results.length > input.limit) {
        break;
      }
      if (page.length < pageSize) {
        exhausted = true;
        break;
      }
    }
    if (results.length > input.limit) {
      const lastResult = results[input.limit - 1];
      if (!lastResult) {
        throw new RegistryError('INTERNAL_ERROR', 500, 'An internal Skill Registry error occurred.');
      }
      return {
        rows: results.slice(0, input.limit).map(({ row }) => row),
        nextAnchor: lastResult.anchor,
      };
    }
    return {
      rows: results.map(({ row }) => row),
      nextAnchor: !exhausted && scanned >= CATALOG_SCAN_LIMIT ? scanAnchor || null : null,
    };
  }

  private async findLatestVersions(packageRows: RegistryModel[], channel: string): Promise<Map<string, RegistryModel>> {
    const latest = new Map<string, RegistryModel>();
    const packageIds = packageRows.map(modelId);
    if (!packageIds.length) {
      return latest;
    }

    const versions = this.database.getRepository('skillRegistryVersions');
    if (typeof versions.findOne !== 'function') {
      const rows = await versions.find({
        filter: { packageId: { $in: packageIds }, channel, status: 'published' },
        sort: ['-publishedAt', '-id'],
        limit: Math.min(CATALOG_SCAN_LIMIT, packageIds.length * 100),
      });
      for (const row of rows) {
        const key = getString(row, 'packageId');
        if (!latest.has(key)) {
          latest.set(key, row);
        }
      }
      return latest;
    }

    if (channel === 'stable') {
      const pointerIds = packageRows
        .map((row) => row.get('latestStableVersionId'))
        .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number');
      if (pointerIds.length) {
        const pointed = await versions.find({
          filter: { id: { $in: pointerIds }, channel, status: 'published' },
          fields: LATEST_VERSION_FIELDS,
          limit: pointerIds.length,
        });
        for (const row of pointed) {
          const key = getString(row, 'packageId');
          if (packageIds.includes(key)) {
            latest.set(key, row);
          }
        }
      }
    }

    const missing = packageIds.filter((packageId) => !latest.has(packageId));
    for (let offset = 0; offset < missing.length; offset += 10) {
      const batch = missing.slice(offset, offset + 10);
      const rows = await Promise.all(
        batch.map((packageId) =>
          versions.findOne({
            filter: { packageId, channel, status: 'published' },
            sort: ['-publishedAt', '-id'],
            fields: LATEST_VERSION_FIELDS,
          }),
        ),
      );
      for (const row of rows) {
        if (row) {
          latest.set(getString(row, 'packageId'), row);
        }
      }
    }
    return latest;
  }

  async getPackage(packageName: string, userId?: string): Promise<RegistryModel> {
    const identity = splitPackageName(packageName);
    const packageRecord = await this.database.getRepository('skillRegistryPackages').findOne({
      filter: { ...identity, status: 'published' },
    });
    if (!packageRecord) {
      throw new RegistryError('PACKAGE_NOT_FOUND', 404, 'Package was not found.');
    }
    await this.assertAccess(packageRecord, userId);
    return packageRecord;
  }

  async findLatestVersion(packageId: string, channel: string): Promise<RegistryModel | null> {
    return this.database.getRepository('skillRegistryVersions').findOne({
      filter: { packageId, channel, status: 'published' },
      sort: ['-publishedAt', '-id'],
    });
  }

  async listVersions(
    packageRecord: RegistryModel,
    channel: string,
    limit: number,
    after?: PublicCursorAnchor,
    userId?: string,
  ): Promise<CatalogPage<RegistryModel>> {
    await this.assertAccess(packageRecord, userId);
    const rows = await this.database.getRepository('skillRegistryVersions').find({
      filter: afterFilter({ packageId: modelId(packageRecord), channel, status: 'published' }, after, 'descending'),
      sort: ['-publishedAt', '-id'],
      fields: LATEST_VERSION_FIELDS,
      limit: limit + 1,
    });
    if (rows.length <= limit) {
      return { rows, nextAnchor: null };
    }
    const page = rows.slice(0, limit);
    const lastVersion = page[page.length - 1];
    if (!lastVersion) {
      throw new RegistryError('INTERNAL_ERROR', 500, 'An internal Skill Registry error occurred.');
    }
    return { rows: page, nextAnchor: cursorAnchor(lastVersion) };
  }

  async resolveVersion(
    packageName: string,
    version?: string,
    channel = 'stable',
    userId?: string,
  ): Promise<{ packageRecord: RegistryModel; versionRecord: RegistryModel }> {
    const packageRecord = await this.getPackage(packageName, userId);
    const versions = this.database.getRepository('skillRegistryVersions');
    const versionRecord = version
      ? await versions.findOne({ filter: { packageId: modelId(packageRecord), version, channel, status: 'published' } })
      : await this.findLatestVersion(modelId(packageRecord), channel);
    if (!versionRecord) {
      throw new RegistryError('VERSION_NOT_FOUND', 404, 'Published package version was not found.');
    }
    return { packageRecord, versionRecord };
  }

  private async assertAccess(packageRecord: RegistryModel, userId?: string): Promise<void> {
    const visibility = getString(packageRecord, 'visibility') || 'public';
    if (visibility === 'public') {
      return;
    }
    if (!userId) {
      throw new RegistryError('PACKAGE_NOT_FOUND', 404, 'Package was not found.');
    }
    if (String(packageRecord.get('ownerId')) === String(userId)) {
      return;
    }
    if (visibility === 'shared') {
      const share = await this.database.getRepository('skillRegistryPackageShares').findOne({
        filter: { packageId: modelId(packageRecord), userId },
      });
      if (share) {
        return;
      }
    }
    throw new RegistryError('PACKAGE_NOT_FOUND', 404, 'Package was not found.');
  }
}
