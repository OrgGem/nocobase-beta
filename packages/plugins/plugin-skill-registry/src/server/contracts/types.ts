export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type RegistryProviderType = 'skill-hub' | 'git-manager';
export type RegistryVersionStatus = 'discovered' | 'validating' | 'ready' | 'published' | 'rejected' | 'yanked';

/**
 * Identity used when a source provider reads content on behalf of Registry.
 * A scheduled sync is deliberately distinct from a request made by an admin:
 * Git Manager may bypass the current user's repository scope only for the
 * explicitly fenced scheduled-sync path.
 */
export type RegistrySourceAccessContext =
  | {
      kind: 'user';
      userId?: string | number;
      roles: string[];
    }
  | {
      kind: 'system';
      reason: 'scheduled-sync';
    };

export interface RegistrySkillManifestV1 {
  schemaVersion: 'registry.skill.nocobase.io/v1';
  name: string;
  version?: string;
  displayName: string;
  description: string;
  license?: string;
  runtime: {
    kind: 'python' | 'node' | 'instruction';
    entrypoint: string;
  };
  inputSchema: JsonValue;
  outputSchema: JsonValue;
  permissions: JsonValue;
  dependencies: JsonValue;
  compatibility: JsonValue;
  tags: string[];
}

export interface RegistrySkillFile {
  path: string;
  content: Buffer;
}

export interface RegistrySkillCandidateV1 {
  contractVersion: 'registry-candidate/v1';
  source: {
    provider: RegistryProviderType;
    sourceId: string;
    externalKey: string;
    revision: string;
  };
  identity: {
    namespace: string;
    slug: string;
    suggestedVersion?: string;
  };
  manifest: RegistrySkillManifestV1;
  files: RegistrySkillFile[];
  candidateDigest: string;
}

export interface RegistrySourceDescriptor {
  id: string;
  providerType: RegistryProviderType;
  namespace: string;
  providerConfig: JsonValue;
}

export interface SourceItemDescriptor {
  id: string;
  sourceId: string;
  externalKey: string;
  sourceRevision: string;
  candidateDigest: string;
}

export interface RegistrySourceProvider {
  readonly type: RegistryProviderType;
  /** Validate a source binding before it is persisted, when the provider owns ACL. */
  assertAccess?(source: RegistrySourceDescriptor, access: RegistrySourceAccessContext): Promise<void>;
  discover(source: RegistrySourceDescriptor, access?: RegistrySourceAccessContext): Promise<string[]>;
  getCandidate(
    source: RegistrySourceDescriptor,
    externalKey: string,
    access?: RegistrySourceAccessContext,
  ): Promise<RegistrySkillCandidateV1>;
  releaseSource?(source: RegistrySourceDescriptor): void | Promise<void>;
}

export interface RegistryPublicPackage {
  name: string;
  displayName: string;
  description: string;
  tags: string[];
  latest: {
    version: string;
    channel: string;
    artifactDigest: string;
  } | null;
  compatibility: JsonValue;
  downloads: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asJsonValue(value: unknown, fallback: JsonValue): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => asJsonValue(item, null));
  }
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        result[key] = asJsonValue(item, null);
      }
    }
    return result;
  }
  return fallback;
}
