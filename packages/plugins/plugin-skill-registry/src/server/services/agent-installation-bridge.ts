import { RegistryError } from '../contracts/errors';
import { verifyArtifactBinding } from './artifact-verifier';
import { sha256 } from './canonical-json';
import { FilesystemArtifactStore } from './filesystem-artifact-store';
import { getString, type RegistryModel } from './model-values';
import type { RegistryDatabase } from './repository-types';
import { SignatureService } from './signature-service';
import { normalizeRelativePath } from './validation';
import { packageOperationLockKey, tryRunRegistryOperation, type RegistryOperationLockManager } from './operation-lock';

interface AgentInstallationService {
  installRegistryVersion(input: {
    registryPackageId: string | number;
    registryVersionId: string | number;
    packageIdentity: string;
    version: string;
    channel: string;
    artifactDigest: string;
    sourceSignature: string | null;
    updatePolicy: 'pinned' | 'channel';
    runtime: 'python' | 'node';
    codeTemplate: string;
    entrypoint: string;
    files: Array<{ path: string; content: Buffer }>;
    instructions: string;
    inputSchema: unknown;
    dependencies: unknown;
    installedById?: string | number;
  }): Promise<{ installationId: string; skillDefinitionId: string; toolName: string; status: 'installed' }>;
  getRollbackTarget(installationId: string | number): Promise<{
    registryVersionId: string;
    updatePolicy: 'pinned' | 'channel';
  } | null>;
  getRegistryInstallationStates(registryVersionIds: Array<string | number>): Promise<
    Array<{
      installationId: string;
      registryPackageId: string;
      registryVersionId: string;
      skillDefinitionId: string;
      version: string;
      updatePolicy: 'pinned' | 'channel';
      status: string;
      installedAt: string | null;
    }>
  >;
}

type PluginManager = {
  get(name: string): unknown;
};

function serviceFor(pluginManager: PluginManager): AgentInstallationService {
  const plugin = pluginManager.get('plugin-agent-orchestrator');
  if (!plugin || typeof plugin !== 'object') {
    throw new RegistryError('SOURCE_PROVIDER_UNAVAILABLE', 424, 'Agent Orchestrator is not enabled.');
  }
  const service = (plugin as { registrySkillInstallationService?: unknown }).registrySkillInstallationService;
  if (
    !service ||
    typeof service !== 'object' ||
    typeof (service as { installRegistryVersion?: unknown }).installRegistryVersion !== 'function'
  ) {
    throw new RegistryError(
      'SOURCE_PROVIDER_UNAVAILABLE',
      424,
      'Agent Orchestrator does not expose its registry installation service.',
    );
  }
  return service as AgentInstallationService;
}

function modelId(model: RegistryModel): string {
  return getString(model, 'id');
}

function instructionText(file: Buffer | undefined): string {
  if (!file) {
    return '';
  }
  return file.toString('utf8').replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, '');
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function installationLockTtlMs(): number {
  return positiveInteger(process.env.SKILL_REGISTRY_INSTALL_LOCK_TTL_MS, 10 * 60 * 1000, 60 * 60 * 1000);
}

export class AgentInstallationBridge {
  constructor(
    private readonly database: RegistryDatabase,
    private readonly artifactStore: FilesystemArtifactStore,
    private readonly pluginManager: PluginManager,
    private readonly signatureService: SignatureService,
    private readonly lockManager?: RegistryOperationLockManager,
  ) {}

  private async findPublishedVersion(versionId: string | number): Promise<RegistryModel> {
    const versions = this.database.getRepository('skillRegistryVersions');
    const version = await versions.findOne({ filterByTk: versionId });
    if (!version || getString(version, 'status') !== 'published') {
      throw new RegistryError('VERSION_NOT_FOUND', 404, 'Published registry version was not found.');
    }
    if (!getString(version, 'packageId')) {
      throw new RegistryError('ARTIFACT_UNAVAILABLE', 409, 'Published registry version has no package binding.');
    }
    return version;
  }

  private async runPackageOperation<T>(packageId: string, operation: () => Promise<T>): Promise<T> {
    const attempted = await tryRunRegistryOperation(
      this.lockManager,
      packageOperationLockKey(packageId),
      installationLockTtlMs(),
      operation,
    );
    if (!attempted.acquired) {
      throw new RegistryError(
        'REGISTRY_OPERATION_BUSY',
        409,
        'Another install or rollback is already modifying this registry package. Retry the request.',
      );
    }
    return attempted.value;
  }

  async install(versionId: string | number, updatePolicy: 'pinned' | 'channel', installedById?: string | number) {
    // Read once only to determine the package lock. The version is deliberately
    // re-read inside that lock, so a concurrent yank cannot leave the Agent
    // Orchestrator disk state ahead of Registry's database state.
    const initialVersion = await this.findPublishedVersion(versionId);
    const packageId = getString(initialVersion, 'packageId');
    return this.runPackageOperation(packageId, async () => {
      const lockedVersion = await this.findPublishedVersion(versionId);
      return this.installWithVersion(lockedVersion, updatePolicy, installedById);
    });
  }

  private async installWithVersion(
    version: RegistryModel,
    updatePolicy: 'pinned' | 'channel',
    installedById?: string | number,
  ) {
    const packageRecord = await this.database.getRepository('skillRegistryPackages').findOne({
      filterByTk: getString(version, 'packageId'),
    });
    const artifact = await this.database.getRepository('skillRegistryArtifacts').findOne({
      filterByTk: getString(version, 'artifactId'),
    });
    if (!packageRecord || !artifact || getString(artifact, 'verificationStatus') !== 'verified') {
      throw new RegistryError('ARTIFACT_UNAVAILABLE', 409, 'Registry artifact is unavailable.');
    }
    const artifactBytes = await this.artifactStore.read(getString(artifact, 'storageKey'));
    if (sha256(artifactBytes) !== getString(version, 'artifactDigest')) {
      throw new RegistryError('ARTIFACT_DIGEST_MISMATCH', 409, 'Stored registry artifact failed digest verification.');
    }
    const packageIdentity = `${getString(packageRecord, 'namespace')}/${getString(packageRecord, 'slug')}`;
    const sourceSignature = getString(version, 'registrySignature') || null;
    if (
      sourceSignature &&
      !this.signatureService.verifyEnvelope(
        {
          packageName: packageIdentity,
          version: getString(version, 'version'),
          manifestDigest: getString(version, 'manifestDigest'),
          artifactDigest: getString(version, 'artifactDigest'),
        },
        sourceSignature,
        getString(version, 'signatureKeyId') || undefined,
      )
    ) {
      throw new RegistryError('SIGNATURE_INVALID', 409, 'Registry artifact signature verification failed.');
    }
    const unpacked = verifyArtifactBinding(artifactBytes, {
      packageName: packageIdentity,
      version: getString(version, 'version'),
      runtime: getString(version, 'runtime'),
      entrypoint: getString(version, 'entrypoint'),
      manifest: version.get('manifest'),
      manifestDigest: getString(version, 'manifestDigest'),
      artifactManifestDigest: getString(artifact, 'manifestDigest'),
    });
    const entrypoint = normalizeRelativePath(unpacked.manifest.runtime.entrypoint);
    const entrypointCode = unpacked.files.get(entrypoint);
    if (!entrypointCode) {
      throw new RegistryError('INVALID_MANIFEST', 422, 'Artifact entrypoint is missing.');
    }
    if (unpacked.manifest.runtime.kind === 'instruction') {
      throw new RegistryError(
        'INVALID_MANIFEST',
        422,
        'Instruction-only registry skills cannot be installed as executable Agent Orchestrator skills.',
      );
    }
    return serviceFor(this.pluginManager).installRegistryVersion({
      registryPackageId: modelId(packageRecord),
      registryVersionId: modelId(version),
      packageIdentity,
      version: getString(version, 'version'),
      channel: getString(version, 'channel'),
      artifactDigest: getString(version, 'artifactDigest'),
      sourceSignature,
      updatePolicy,
      runtime: unpacked.manifest.runtime.kind,
      codeTemplate: entrypointCode.toString('utf8'),
      entrypoint,
      files: Array.from(unpacked.files, ([path, content]) => ({ path, content })),
      instructions: instructionText(unpacked.files.get('SKILL.md')),
      inputSchema: unpacked.manifest.inputSchema,
      dependencies: unpacked.manifest.dependencies,
      installedById,
    });
  }

  async verify(versionId: string | number) {
    const version = await this.database.getRepository('skillRegistryVersions').findOne({ filterByTk: versionId });
    if (!version || getString(version, 'status') !== 'published') {
      throw new RegistryError('VERSION_NOT_FOUND', 404, 'Published registry version was not found.');
    }
    const packageRecord = await this.database.getRepository('skillRegistryPackages').findOne({
      filterByTk: getString(version, 'packageId'),
    });
    const artifact = await this.database.getRepository('skillRegistryArtifacts').findOne({
      filterByTk: getString(version, 'artifactId'),
    });
    if (!packageRecord || !artifact || getString(artifact, 'verificationStatus') !== 'verified') {
      throw new RegistryError('ARTIFACT_UNAVAILABLE', 409, 'Registry artifact is unavailable.');
    }
    const artifactBytes = await this.artifactStore.read(getString(artifact, 'storageKey'));
    if (sha256(artifactBytes) !== getString(version, 'artifactDigest')) {
      throw new RegistryError('ARTIFACT_DIGEST_MISMATCH', 409, 'Stored registry artifact failed digest verification.');
    }
    const packageIdentity = `${getString(packageRecord, 'namespace')}/${getString(packageRecord, 'slug')}`;
    const sourceSignature = getString(version, 'registrySignature') || null;
    if (
      sourceSignature &&
      !this.signatureService.verifyEnvelope(
        {
          packageName: packageIdentity,
          version: getString(version, 'version'),
          manifestDigest: getString(version, 'manifestDigest'),
          artifactDigest: getString(version, 'artifactDigest'),
        },
        sourceSignature,
        getString(version, 'signatureKeyId') || undefined,
      )
    ) {
      throw new RegistryError('SIGNATURE_INVALID', 409, 'Registry artifact signature verification failed.');
    }
    verifyArtifactBinding(artifactBytes, {
      packageName: packageIdentity,
      version: getString(version, 'version'),
      runtime: getString(version, 'runtime'),
      entrypoint: getString(version, 'entrypoint'),
      manifest: version.get('manifest'),
      manifestDigest: getString(version, 'manifestDigest'),
      artifactManifestDigest: getString(artifact, 'manifestDigest'),
    });
    return {
      versionId: modelId(version),
      artifactDigest: getString(version, 'artifactDigest'),
      signatureVerified: Boolean(sourceSignature),
    };
  }

  async rollback(installationId: string | number, installedById?: string | number) {
    const service = serviceFor(this.pluginManager);
    if (typeof service.getRollbackTarget !== 'function') {
      throw new RegistryError(
        'SOURCE_PROVIDER_UNAVAILABLE',
        424,
        'Agent Orchestrator does not expose registry rollback targets.',
      );
    }
    const initialTarget = await service.getRollbackTarget(installationId);
    if (!initialTarget) {
      throw new RegistryError(
        'ROLLBACK_UNAVAILABLE',
        409,
        'The installation has no previous registry version to restore.',
      );
    }
    const initialVersion = await this.findPublishedVersion(initialTarget.registryVersionId);
    const packageId = getString(initialVersion, 'packageId');
    return this.runPackageOperation(packageId, async () => {
      // The target can change while this request is waiting on an installation
      // lock. Re-read it after acquiring the lock, then verify the selected
      // version before Agent Orchestrator touches its package files.
      const lockedTarget = await service.getRollbackTarget(installationId);
      if (!lockedTarget) {
        throw new RegistryError(
          'ROLLBACK_UNAVAILABLE',
          409,
          'The installation no longer has a registry version to restore.',
        );
      }
      const lockedVersion = await this.findPublishedVersion(lockedTarget.registryVersionId);
      if (getString(lockedVersion, 'packageId') !== packageId) {
        throw new RegistryError(
          'REGISTRY_OPERATION_BUSY',
          409,
          'The rollback target changed while waiting for the package operation lock. Retry the request.',
        );
      }
      return this.installWithVersion(lockedVersion, lockedTarget.updatePolicy, installedById);
    });
  }

  async installationStates(versionIds: Array<string | number>) {
    const service = serviceFor(this.pluginManager);
    if (typeof service.getRegistryInstallationStates !== 'function') {
      throw new RegistryError(
        'SOURCE_PROVIDER_UNAVAILABLE',
        424,
        'Agent Orchestrator does not expose registry installation states.',
      );
    }
    return service.getRegistryInstallationStates(versionIds);
  }
}
