import type {
  JsonValue,
  RegistrySkillCandidateV1,
  RegistrySkillFile,
  RegistrySourceDescriptor,
  RegistrySourceProvider,
} from '../contracts/types';
import { isRecord } from '../contracts/types';
import { RegistryError } from '../contracts/errors';
import { ARTIFACT_LIMITS } from '../services/artifact-builder';
import { candidateDigest } from '../services/canonical-json';
import { SOURCE_INGESTION_LIMITS, validateDiscoveredExternalKeys } from '../services/candidate-validator';
import { normalizeIdentity } from '../services/validation';

interface SkillSnapshotSummary {
  id: string;
}

interface SkillHubSnapshot {
  id: string;
  name: string;
  title: string;
  description: string;
  language: 'python' | 'node';
  suggestedVersion?: string;
  inputSchema: JsonValue;
  instructions: string;
  files: Array<{ path: string; content: Buffer }>;
  portable: boolean;
  reason?: string;
  revision: string;
  dependencies: JsonValue;
}

interface SkillSnapshotService {
  listSkillSnapshots(): Promise<SkillSnapshotSummary[]>;
  getSkillSnapshot(skillDefinitionId: string): Promise<SkillHubSnapshot>;
}

type PluginManager = {
  get(name: string): unknown;
};

async function requireSkillHubExport<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (isRecord(error) && error.code === 'REGISTRY_EXPORT_NOT_GRANTED') {
      throw new RegistryError(
        'SOURCE_EXPORT_NOT_GRANTED',
        403,
        'Skill Hub definition is not authorized for Skill Registry export.',
      );
    }
    if (isRecord(error) && error.code === 'REGISTRY_EXPORT_LIMIT_EXCEEDED') {
      throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Skill Hub source content exceeds the registry limit.');
    }
    throw error;
  }
}

function getSnapshotService(pluginManager: PluginManager): SkillSnapshotService {
  const plugin = pluginManager.get('plugin-agent-orchestrator');
  if (!plugin || typeof plugin !== 'object') {
    throw new RegistryError('SOURCE_PROVIDER_UNAVAILABLE', 424, 'Agent Orchestrator is not enabled.');
  }
  const service = (plugin as { registrySkillSnapshotService?: unknown }).registrySkillSnapshotService;
  if (
    !service ||
    typeof service !== 'object' ||
    typeof (service as { listSkillSnapshots?: unknown }).listSkillSnapshots !== 'function' ||
    typeof (service as { getSkillSnapshot?: unknown }).getSkillSnapshot !== 'function'
  ) {
    throw new RegistryError(
      'SOURCE_PROVIDER_UNAVAILABLE',
      424,
      'Agent Orchestrator does not expose its registry snapshot service.',
    );
  }
  return service as SkillSnapshotService;
}

function parseExternalKey(externalKey: string): string {
  const match = externalKey.match(/^skillDefinitions:(.+)$/);
  if (!match) {
    throw new RegistryError('INVALID_MANIFEST', 422, `Invalid Skill Hub source item ${externalKey}.`);
  }
  return match[1];
}

function allowedSkillDefinitionIds(source: RegistrySourceDescriptor): Set<string> | null {
  if (!isRecord(source.providerConfig)) {
    return null;
  }
  const value = source.providerConfig.skillDefinitionIds;
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' && typeof id !== 'number')) {
    throw new RegistryError(
      'INVALID_MANIFEST',
      422,
      'providerConfig.skillDefinitionIds must be an array of skill definition ids.',
    );
  }
  if (value.length > SOURCE_INGESTION_LIMITS.maxItems) {
    throw new RegistryError('SOURCE_ITEM_LIMIT_EXCEEDED', 422, 'Skill Hub source contains too many skill definitions.');
  }
  return new Set(value.map(String));
}

function normalizeFiles(files: Array<{ path: string; content: Buffer }>): RegistrySkillFile[] {
  if (files.length > Math.max(0, ARTIFACT_LIMITS.maxFiles - 1)) {
    throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Skill Hub snapshot contains too many files.');
  }
  let totalBytes = 0;
  return files.map((file) => {
    if (!Buffer.isBuffer(file.content) || file.content.length > SOURCE_INGESTION_LIMITS.maxFileBytes) {
      throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Skill Hub snapshot contains an oversized file.');
    }
    totalBytes += file.content.length;
    if (totalBytes > ARTIFACT_LIMITS.maxExpandedBytes) {
      throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Skill Hub snapshot exceeds the expanded artifact limit.');
    }
    return { path: file.path, content: file.content };
  });
}

export class SkillHubSourceProvider implements RegistrySourceProvider {
  readonly type = 'skill-hub' as const;

  constructor(private readonly pluginManager: PluginManager) {}

  async discover(source: RegistrySourceDescriptor): Promise<string[]> {
    const allowed = allowedSkillDefinitionIds(source);
    const snapshots = await requireSkillHubExport(getSnapshotService(this.pluginManager).listSkillSnapshots());
    if (!Array.isArray(snapshots) || snapshots.length > SOURCE_INGESTION_LIMITS.maxItems) {
      throw new RegistryError(
        'SOURCE_ITEM_LIMIT_EXCEEDED',
        422,
        'Skill Hub source contains too many skill definitions.',
      );
    }
    return validateDiscoveredExternalKeys(
      snapshots
        .filter((snapshot) => !allowed || allowed.has(String(snapshot.id)))
        .map((snapshot) => `skillDefinitions:${snapshot.id}`),
    );
  }

  async getCandidate(source: RegistrySourceDescriptor, externalKey: string): Promise<RegistrySkillCandidateV1> {
    const skillDefinitionId = parseExternalKey(externalKey);
    const allowed = allowedSkillDefinitionIds(source);
    // Enforce the scope here too, so narrowing a source blocks publishes of
    // already-discovered items that fell out of scope.
    if (allowed && !allowed.has(skillDefinitionId)) {
      throw new RegistryError('INVALID_MANIFEST', 422, `Skill Hub item ${externalKey} is outside the source scope.`);
    }
    const snapshot = await requireSkillHubExport(
      getSnapshotService(this.pluginManager).getSkillSnapshot(skillDefinitionId),
    );
    if (!isRecord(snapshot) || !Array.isArray(snapshot.files) || typeof snapshot.instructions !== 'string') {
      throw new RegistryError('INVALID_MANIFEST', 422, 'Skill Hub returned an invalid registry snapshot.');
    }
    if (!snapshot.portable) {
      throw new RegistryError(
        'NON_PORTABLE_SKILL',
        422,
        snapshot.reason || 'Skill Hub definition cannot be exported as a portable artifact.',
      );
    }
    if (Buffer.byteLength(snapshot.instructions, 'utf8') > SOURCE_INGESTION_LIMITS.maxFileBytes) {
      throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Skill Hub instructions exceed the source-file limit.');
    }
    const namespace = normalizeIdentity(source.namespace, 'namespace');
    const slug = normalizeIdentity(snapshot.name, 'slug');
    const files = normalizeFiles(snapshot.files);
    const entrypoint = files.find((file) => /(^|\/)index\.(py|js)$/.test(file.path))?.path;
    if (!entrypoint) {
      throw new RegistryError('NON_PORTABLE_SKILL', 422, 'Skill Hub snapshot does not include a supported entrypoint.');
    }
    const manifest = {
      schemaVersion: 'registry.skill.nocobase.io/v1' as const,
      name: `${namespace}/${slug}`,
      ...(snapshot.suggestedVersion ? { version: snapshot.suggestedVersion } : {}),
      displayName: snapshot.title || snapshot.name,
      description: snapshot.description || '',
      runtime: { kind: snapshot.language, entrypoint },
      inputSchema: snapshot.inputSchema,
      outputSchema: { type: 'object' },
      permissions: { network: 'deny', filesystem: ['workdir:read', 'output:write'] },
      dependencies: snapshot.dependencies,
      compatibility: { nocobase: '>=2.0.0', agentOrchestrator: '>=1.0.0' },
      tags: [],
    };
    return {
      contractVersion: 'registry-candidate/v1',
      source: {
        provider: this.type,
        sourceId: source.id,
        externalKey,
        revision: snapshot.revision,
      },
      identity: {
        namespace,
        slug,
        ...(snapshot.suggestedVersion ? { suggestedVersion: snapshot.suggestedVersion } : {}),
      },
      manifest,
      files,
      candidateDigest: candidateDigest(manifest, files),
    };
  }
}
