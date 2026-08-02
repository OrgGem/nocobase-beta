import { AgentInstallationBridge } from '../services/agent-installation-bridge';
import { buildArtifact } from '../services/artifact-builder';
import type { RegistrySkillManifestV1 } from '../contracts/types';
import type { RegistryDatabase, RegistryRepository } from '../services/repository-types';
import { SignatureService } from '../services/signature-service';

function model(values: Record<string, unknown>) {
  return { get: (attribute: string) => values[attribute] };
}

const baseManifest: RegistrySkillManifestV1 = {
  schemaVersion: 'registry.skill.nocobase.io/v1',
  name: 'acme/report',
  version: '1.0.0',
  displayName: 'Report',
  description: 'Create a report.',
  runtime: { kind: 'python', entrypoint: 'src/index.py' },
  inputSchema: { type: 'object', properties: {} },
  outputSchema: { type: 'object' },
  permissions: { network: 'deny' },
  dependencies: [],
  compatibility: { nocobase: '>=2.0.0' },
  tags: ['report'],
};

function artifactFixture(manifestOverrides: Partial<RegistrySkillManifestV1> = {}) {
  const manifest: RegistrySkillManifestV1 = {
    ...baseManifest,
    ...manifestOverrides,
    runtime: manifestOverrides.runtime || baseManifest.runtime,
  };
  return {
    ...buildArtifact({
      contractVersion: 'registry-candidate/v1',
      source: {
        provider: 'skill-hub',
        sourceId: 'source-1',
        externalKey: 'skillDefinitions:1',
        revision: 'revision-1',
      },
      identity: { namespace: 'acme', slug: 'report' },
      manifest,
      files: [
        { path: 'SKILL.md', content: Buffer.from('# Report\n') },
        { path: 'src/index.py', content: Buffer.from('print("report")\n') },
      ],
      candidateDigest: `sha256:${'b'.repeat(64)}`,
    }),
    manifest,
  };
}

function registryDatabase(
  builtArtifact: ReturnType<typeof artifactFixture>,
  overrides: {
    version?: Record<string, unknown>;
    package?: Record<string, unknown>;
    artifact?: Record<string, unknown>;
  } = {},
): RegistryDatabase {
  const version = model({
    id: 'version-1',
    status: 'published',
    packageId: 'package-1',
    artifactId: 'artifact-1',
    artifactDigest: builtArtifact.digest,
    version: '1.0.0',
    channel: 'stable',
    manifest: builtArtifact.manifest,
    manifestDigest: builtArtifact.manifestDigest,
    runtime: 'python',
    entrypoint: 'src/index.py',
    registrySignature: null,
    signatureKeyId: null,
    ...overrides.version,
  });
  const packageRecord = model({ id: 'package-1', namespace: 'acme', slug: 'report', ...overrides.package });
  const artifact = model({
    id: 'artifact-1',
    verificationStatus: 'verified',
    storageKey: 'artifact.zip',
    manifestDigest: builtArtifact.manifestDigest,
    ...overrides.artifact,
  });
  const repositories: Record<string, RegistryRepository> = {
    skillRegistryVersions: { findOne: vi.fn().mockResolvedValue(version) } as unknown as RegistryRepository,
    skillRegistryPackages: { findOne: vi.fn().mockResolvedValue(packageRecord) } as unknown as RegistryRepository,
    skillRegistryArtifacts: { findOne: vi.fn().mockResolvedValue(artifact) } as unknown as RegistryRepository,
  };
  return {
    getRepository(name: string): RegistryRepository {
      const repository = repositories[name];
      if (!repository) {
        throw new Error(`Unexpected repository ${name}`);
      }
      return repository;
    },
  };
}

describe('AgentInstallationBridge', () => {
  it('reads installation states only through the Agent Orchestrator service contract', async () => {
    const artifact = artifactFixture();
    const installationService = {
      installRegistryVersion: vi.fn(),
      getRegistryInstallationStates: vi
        .fn()
        .mockResolvedValue([{ installationId: 'installation-1', registryVersionId: 'version-1', status: 'installed' }]),
    };
    const bridge = new AgentInstallationBridge(
      registryDatabase(artifact),
      {} as never,
      { get: vi.fn().mockReturnValue({ registrySkillInstallationService: installationService }) },
      new SignatureService(),
    );

    await expect(bridge.installationStates(['version-1'])).resolves.toEqual([
      expect.objectContaining({ registryVersionId: 'version-1', status: 'installed' }),
    ]);
    expect(installationService.getRegistryInstallationStates).toHaveBeenCalledWith(['version-1']);
  });

  it('re-verifies and unpacks an immutable artifact before reporting it as installable', async () => {
    const artifact = artifactFixture();
    const artifactStore = { read: vi.fn().mockResolvedValue(artifact.content) };
    const bridge = new AgentInstallationBridge(
      registryDatabase(artifact),
      artifactStore as never,
      { get: vi.fn() },
      new SignatureService(),
    );

    await expect(bridge.verify('version-1')).resolves.toEqual({
      versionId: 'version-1',
      artifactDigest: artifact.digest,
      signatureVerified: false,
    });
    expect(artifactStore.read).toHaveBeenCalledWith('artifact.zip');
  });

  it('rejects an extracted manifest that differs from the stored manifest digest even when ZIP digest matches', async () => {
    const publishedArtifact = artifactFixture();
    const replacedManifestArtifact = artifactFixture({ name: 'attacker/replacement' });
    const bridge = new AgentInstallationBridge(
      registryDatabase(publishedArtifact, {
        version: { artifactDigest: replacedManifestArtifact.digest },
      }),
      { read: vi.fn().mockResolvedValue(replacedManifestArtifact.content) } as never,
      { get: vi.fn() },
      new SignatureService(),
    );

    await expect(bridge.verify('version-1')).rejects.toMatchObject({ code: 'ARTIFACT_DIGEST_MISMATCH' });
  });

  it.each([
    ['package identity', { name: 'attacker/report' }],
    ['version', { version: '2.0.0' }],
    ['runtime', { runtime: { kind: 'node', entrypoint: 'src/index.py' } }],
    ['entrypoint', { runtime: { kind: 'python', entrypoint: 'SKILL.md' } }],
  ] as Array<[string, Partial<RegistrySkillManifestV1>]>)(
    'rejects a manifest with mismatched %s',
    async (_label, overrides) => {
      const artifact = artifactFixture(overrides);
      const bridge = new AgentInstallationBridge(
        registryDatabase(artifact),
        { read: vi.fn().mockResolvedValue(artifact.content) } as never,
        { get: vi.fn() },
        new SignatureService(),
      );

      await expect(bridge.verify('version-1')).rejects.toMatchObject({ code: 'ARTIFACT_DIGEST_MISMATCH' });
    },
  );

  it('does not hand a mismatched manifest to Agent Orchestrator during install', async () => {
    const artifact = artifactFixture({ name: 'attacker/report' });
    const installationService = { installRegistryVersion: vi.fn() };
    const bridge = new AgentInstallationBridge(
      registryDatabase(artifact),
      { read: vi.fn().mockResolvedValue(artifact.content) } as never,
      { get: vi.fn().mockReturnValue({ registrySkillInstallationService: installationService }) },
      new SignatureService(),
    );

    await expect(bridge.install('version-1', 'pinned')).rejects.toMatchObject({ code: 'ARTIFACT_DIGEST_MISMATCH' });
    expect(installationService.installRegistryVersion).not.toHaveBeenCalled();
  });

  it('returns a stable busy error before Agent Orchestrator changes package files', async () => {
    const artifact = artifactFixture();
    const installationService = { installRegistryVersion: vi.fn() };
    const tryAcquire = vi.fn().mockRejectedValue(new Error('already locked'));
    const bridge = new AgentInstallationBridge(
      registryDatabase(artifact),
      { read: vi.fn().mockResolvedValue(artifact.content) } as never,
      { get: vi.fn().mockReturnValue({ registrySkillInstallationService: installationService }) },
      new SignatureService(),
      { tryAcquire } as never,
    );

    await expect(bridge.install('version-1', 'pinned')).rejects.toMatchObject({
      code: 'REGISTRY_OPERATION_BUSY',
      status: 409,
    });
    expect(tryAcquire).toHaveBeenCalledWith('skill-registry:package:package-1', 0);
    expect(installationService.installRegistryVersion).not.toHaveBeenCalled();
  });

  it('re-reads the version after acquiring the package lock and stops a concurrent yank', async () => {
    const artifact = artifactFixture();
    const published = model({
      id: 'version-1',
      status: 'published',
      packageId: 'package-1',
      artifactId: 'artifact-1',
    });
    const yanked = model({
      id: 'version-1',
      status: 'yanked',
      packageId: 'package-1',
      artifactId: 'artifact-1',
    });
    const versions = { findOne: vi.fn().mockResolvedValueOnce(published).mockResolvedValueOnce(yanked) };
    const bridge = new AgentInstallationBridge(
      {
        getRepository: (name: string) => {
          if (name === 'skillRegistryVersions') return versions as never;
          throw new Error(`Unexpected repository ${name}`);
        },
      } as never,
      {} as never,
      { get: vi.fn() },
      new SignatureService(),
      {
        tryAcquire: vi.fn().mockResolvedValue({ runExclusive: (operation: () => Promise<unknown>) => operation() }),
      } as never,
    );

    await expect(bridge.install('version-1', 'pinned')).rejects.toMatchObject({
      code: 'VERSION_NOT_FOUND',
      status: 404,
    });
    expect(versions.findOne).toHaveBeenCalledTimes(2);
  });

  it('restores the previous installation only through Agent Orchestrator and a verified registry artifact', async () => {
    const artifact = artifactFixture();
    const installationService = {
      getRollbackTarget: vi.fn().mockResolvedValue({ registryVersionId: 'version-1', updatePolicy: 'pinned' }),
      installRegistryVersion: vi.fn().mockResolvedValue({
        installationId: 'installation-1',
        skillDefinitionId: 'skill-1',
        toolName: 'registry_acme_report',
        status: 'installed',
      }),
    };
    const bridge = new AgentInstallationBridge(
      registryDatabase(artifact),
      { read: vi.fn().mockResolvedValue(artifact.content) } as never,
      { get: vi.fn().mockReturnValue({ registrySkillInstallationService: installationService }) },
      new SignatureService(),
    );

    await expect(bridge.rollback('installation-2', 'admin-1')).resolves.toMatchObject({
      installationId: 'installation-1',
      toolName: 'registry_acme_report',
    });
    expect(installationService.getRollbackTarget).toHaveBeenCalledTimes(2);
    expect(installationService.getRollbackTarget).toHaveBeenNthCalledWith(1, 'installation-2');
    expect(installationService.getRollbackTarget).toHaveBeenNthCalledWith(2, 'installation-2');
    expect(installationService.installRegistryVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        registryVersionId: 'version-1',
        artifactDigest: artifact.digest,
        installedById: 'admin-1',
        updatePolicy: 'pinned',
      }),
    );
  });

  it('re-checks the rollback target after acquiring the package lock', async () => {
    const artifact = artifactFixture();
    const installationService = {
      getRollbackTarget: vi
        .fn()
        .mockResolvedValueOnce({ registryVersionId: 'version-1', updatePolicy: 'pinned' })
        .mockResolvedValueOnce(null),
      installRegistryVersion: vi.fn(),
    };
    const bridge = new AgentInstallationBridge(
      registryDatabase(artifact),
      { read: vi.fn().mockResolvedValue(artifact.content) } as never,
      { get: vi.fn().mockReturnValue({ registrySkillInstallationService: installationService }) },
      new SignatureService(),
      {
        tryAcquire: vi.fn().mockResolvedValue({ runExclusive: (operation: () => Promise<unknown>) => operation() }),
      } as never,
    );

    await expect(bridge.rollback('installation-2', 'admin-1')).rejects.toMatchObject({
      code: 'ROLLBACK_UNAVAILABLE',
      status: 409,
    });
    expect(installationService.getRollbackTarget).toHaveBeenCalledTimes(2);
    expect(installationService.installRegistryVersion).not.toHaveBeenCalled();
  });
});
