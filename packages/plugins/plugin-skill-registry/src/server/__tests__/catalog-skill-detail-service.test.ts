import { buildArtifact } from '../services/artifact-builder';
import { CatalogSkillDetailService } from '../services/catalog-skill-detail-service';
import type { RegistrySkillCandidateV1 } from '../contracts/types';
import type { RegistryModel } from '../services/model-values';
import type { RegistryDatabase, RegistryRepository } from '../services/repository-types';

function model(values: Record<string, unknown>): RegistryModel {
  return { get: (attribute: string) => values[attribute] };
}

function repository(overrides: Partial<RegistryRepository> = {}): RegistryRepository {
  return {
    find: vi.fn().mockResolvedValue([]),
    findOne: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(model({ id: 'created' })),
    update: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function candidate(files: Array<{ path: string; content: Buffer }>): RegistrySkillCandidateV1 {
  return {
    contractVersion: 'registry-candidate/v1',
    source: {
      provider: 'github',
      sourceId: '1',
      externalKey: 'repo:1',
      revision: 'sha256:source',
    },
    identity: { namespace: 'acme', slug: 'report' },
    manifest: {
      schemaVersion: 'registry.skill.nocobase.io/v1',
      name: 'acme/report',
      version: '1.0.0',
      displayName: 'Report',
      description: 'Builds a report',
      runtime: { kind: 'python', entrypoint: 'src/index.py' },
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object' },
      permissions: { network: 'deny' },
      dependencies: [],
      compatibility: { nocobase: '>=2.0.0' },
      tags: ['report'],
    },
    files,
    candidateDigest: 'sha256:candidate',
  };
}

function artifactWithSkillMarkdown(fileName: string, markdown: string): Buffer {
  return buildArtifact(
    candidate([
      { path: 'src/index.py', content: Buffer.from('print("report")\n') },
      { path: fileName, content: Buffer.from(markdown) },
    ]),
  ).content;
}

function createService(repositories: Record<string, RegistryRepository>, readVerified: ReturnType<typeof vi.fn>) {
  const database: RegistryDatabase = {
    getRepository(name: string): RegistryRepository {
      return repositories[name];
    },
  };
  const artifactStore = { readVerified };
  return new CatalogSkillDetailService(database, artifactStore as never);
}

describe('CatalogSkillDetailService.getPackageDetail', () => {
  const markdown = '---\nversion: 1.1.0\ndescription: Builds reports from data.\n---\nFollow these steps.\n';

  it('throws PACKAGE_NOT_FOUND when the package does not exist', async () => {
    const packages = repository({ findOne: vi.fn().mockResolvedValue(null) });
    const service = createService({ skillRegistryPackages: packages }, vi.fn());

    await expect(service.getPackageDetail('missing')).rejects.toMatchObject({
      code: 'PACKAGE_NOT_FOUND',
      status: 404,
    });
  });

  it('extracts skill.md metadata from the latest stable artifact (case-insensitive file name)', async () => {
    const packageRecord = model({ id: 'package-1', latestStableVersionId: 'version-2' });
    const packages = repository({ findOne: vi.fn().mockResolvedValue(packageRecord) });
    const versionFind = vi.fn().mockResolvedValue([
      model({
        id: 'version-2',
        version: '1.1.0',
        channel: 'stable',
        status: 'published',
        changelog: 'New',
        artifactId: 'artifact-2',
        publishedAt: '2026-08-02T00:00:00.000Z',
      }),
      model({
        id: 'version-1',
        version: '1.0.0',
        channel: 'stable',
        status: 'yanked',
        changelog: '',
        artifactId: 'artifact-1',
        publishedAt: '2026-08-01T00:00:00.000Z',
      }),
    ]);
    const versions = repository({ find: versionFind });
    const artifacts = repository({
      findOne: vi.fn().mockResolvedValue({
        get: (attribute: string) =>
          ({
            id: 'artifact-2',
            verificationStatus: 'verified',
            storageKey: 'packages/acme/report/1.1.0.zip',
            digest: 'sha256:artifact',
            sizeBytes: 123,
          })[attribute],
      }),
    });
    const readVerified = vi.fn().mockResolvedValue(artifactWithSkillMarkdown('SKILL.md', markdown));
    const service = createService(
      { skillRegistryPackages: packages, skillRegistryVersions: versions, skillRegistryArtifacts: artifacts },
      readVerified,
    );

    const detail = await service.getPackageDetail('package-1');

    expect(detail.skill).toBe(packageRecord);
    expect(detail.markdown?.frontmatter).toEqual({ version: '1.1.0', description: 'Builds reports from data.' });
    expect(detail.markdown?.body).toBe('Follow these steps.\n');
    expect(detail.versions.map((version) => version.version)).toEqual(['1.1.0', '1.0.0']);
    expect(detail.versions[1].changelog).toBeNull();
    expect(versionFind).toHaveBeenCalledWith({ filter: { packageId: 'package-1' }, sort: ['-publishedAt', '-id'] });
    expect(readVerified).toHaveBeenCalledWith('packages/acme/report/1.1.0.zip', 'sha256:artifact', 123);
  });

  it('reads a lowercase skill.md from in-app markdown skill artifacts', async () => {
    const packageRecord = model({ id: 'package-1', latestStableVersionId: 'version-1' });
    const packages = repository({ findOne: vi.fn().mockResolvedValue(packageRecord) });
    const versions = repository({
      find: vi.fn().mockResolvedValue([
        model({
          id: 'version-1',
          version: '1.0.0',
          channel: 'stable',
          status: 'published',
          changelog: '',
          artifactId: 'artifact-1',
          publishedAt: '2026-08-01T00:00:00.000Z',
        }),
      ]),
    });
    const artifacts = repository({
      findOne: vi
        .fn()
        .mockResolvedValue(model({ verificationStatus: 'verified', storageKey: 'key', digest: 'sha256:d' })),
    });
    const readVerified = vi.fn().mockResolvedValue(artifactWithSkillMarkdown('skill.md', markdown));
    const service = createService(
      { skillRegistryPackages: packages, skillRegistryVersions: versions, skillRegistryArtifacts: artifacts },
      readVerified,
    );

    const detail = await service.getPackageDetail('package-1');

    expect(detail.markdown?.frontmatter).toEqual({ version: '1.1.0', description: 'Builds reports from data.' });
  });

  it('falls back to the latest published version when no stable pointer exists', async () => {
    const packageRecord = model({ id: 'package-1', latestStableVersionId: null });
    const packages = repository({ findOne: vi.fn().mockResolvedValue(packageRecord) });
    const versions = repository({
      find: vi.fn().mockResolvedValue([
        model({
          id: 'version-2',
          version: '2.0.0-beta.1',
          channel: 'beta',
          status: 'published',
          changelog: '',
          artifactId: 'artifact-2',
          publishedAt: '2026-08-02T00:00:00.000Z',
        }),
      ]),
    });
    const artifacts = repository({
      findOne: vi
        .fn()
        .mockResolvedValue(model({ verificationStatus: 'verified', storageKey: 'key', digest: 'sha256:d' })),
    });
    const readVerified = vi.fn().mockResolvedValue(artifactWithSkillMarkdown('SKILL.md', markdown));
    const service = createService(
      { skillRegistryPackages: packages, skillRegistryVersions: versions, skillRegistryArtifacts: artifacts },
      readVerified,
    );

    const detail = await service.getPackageDetail('package-1');

    expect(detail.markdown?.body).toBe('Follow these steps.\n');
    expect(artifacts.findOne).toHaveBeenCalledWith({ filterByTk: 'artifact-2' });
  });

  it('returns null markdown when the package has no versions', async () => {
    const packageRecord = model({ id: 'package-1', latestStableVersionId: null });
    const packages = repository({ findOne: vi.fn().mockResolvedValue(packageRecord) });
    const versions = repository();
    const readVerified = vi.fn();
    const service = createService({ skillRegistryPackages: packages, skillRegistryVersions: versions }, readVerified);

    const detail = await service.getPackageDetail('package-1');

    expect(detail.markdown).toBeNull();
    expect(detail.versions).toEqual([]);
    expect(readVerified).not.toHaveBeenCalled();
  });

  it('returns null markdown when the artifact is not verified', async () => {
    const packageRecord = model({ id: 'package-1', latestStableVersionId: 'version-1' });
    const packages = repository({ findOne: vi.fn().mockResolvedValue(packageRecord) });
    const versions = repository({
      find: vi.fn().mockResolvedValue([
        model({
          id: 'version-1',
          version: '1.0.0',
          channel: 'stable',
          status: 'published',
          changelog: '',
          artifactId: 'artifact-1',
          publishedAt: '2026-08-01T00:00:00.000Z',
        }),
      ]),
    });
    const artifacts = repository({
      findOne: vi
        .fn()
        .mockResolvedValue(model({ verificationStatus: 'pending', storageKey: 'key', digest: 'sha256:d' })),
    });
    const readVerified = vi.fn();
    const service = createService(
      { skillRegistryPackages: packages, skillRegistryVersions: versions, skillRegistryArtifacts: artifacts },
      readVerified,
    );

    const detail = await service.getPackageDetail('package-1');

    expect(detail.markdown).toBeNull();
    expect(readVerified).not.toHaveBeenCalled();
  });
});
