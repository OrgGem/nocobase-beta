export type CredentialMode = 'anonymous' | 'basic' | 'bearer';
export type RegistryArchiveFormat = 'docker' | 'oci';

export interface RegistrySettingsInput {
  displayName?: string;
  registryUrl?: string;
  publicRegistryHost?: string;
  credentialMode?: CredentialMode;
  username?: string;
  password?: string;
  bearerToken?: string;
  verifyTls?: boolean;
  allowInsecureHttp?: boolean;
  caCertificate?: string;
  clientCertificate?: string;
  clientPrivateKey?: string;
  clientPrivateKeyPassphrase?: string;
  requestTimeoutMs?: number;
  catalogPageSize?: number;
  maxConcurrentRequests?: number;
  autoRefreshSeconds?: number;
  deleteEnabled?: boolean;
  rawManifestEnabled?: boolean;
  showLegacySchema1?: boolean;
  maxTransferSizeMb?: number;
  uploadChunkSizeMb?: number;
  transferTimeoutMs?: number;
  clearPassword?: boolean;
  clearBearerToken?: boolean;
  clearClientPrivateKey?: boolean;
  clearClientPrivateKeyPassphrase?: boolean;
}

export interface SafeRegistrySettings {
  id?: number;
  displayName: string;
  registryUrl: string;
  publicRegistryHost: string;
  credentialMode: CredentialMode;
  username: string;
  verifyTls: boolean;
  allowInsecureHttp: boolean;
  caCertificate: string;
  clientCertificate: string;
  requestTimeoutMs: number;
  catalogPageSize: number;
  maxConcurrentRequests: number;
  autoRefreshSeconds: number;
  deleteEnabled: boolean;
  rawManifestEnabled: boolean;
  showLegacySchema1: boolean;
  maxTransferSizeMb: number;
  uploadChunkSizeMb: number;
  transferTimeoutMs: number;
  hasPassword: boolean;
  hasBearerToken: boolean;
  hasClientPrivateKey: boolean;
  hasClientPrivateKeyPassphrase: boolean;
}

export type PublicRegistrySettings = Pick<
  SafeRegistrySettings,
  | 'displayName'
  | 'publicRegistryHost'
  | 'autoRefreshSeconds'
  | 'deleteEnabled'
  | 'rawManifestEnabled'
  | 'maxTransferSizeMb'
>;

export interface RegistryConnection extends SafeRegistrySettings {
  password?: string;
  bearerToken?: string;
  clientPrivateKey?: string;
  clientPrivateKeyPassphrase?: string;
}

export interface Descriptor {
  mediaType?: string;
  artifactType?: string;
  digest: string;
  size?: number;
  annotations?: Record<string, string>;
  platform?: {
    architecture?: string;
    os?: string;
    variant?: string;
  };
}

export interface NormalizedImage {
  kind: 'image';
  mediaType: string;
  digest: string;
  config?: Descriptor;
  layers: Descriptor[];
  size: number;
  created?: string;
  architecture?: string;
  os?: string;
  configData?: Record<string, unknown>;
  raw?: Record<string, unknown>;
  referrers?: Descriptor[];
  referrersSupported?: boolean;
}

export interface NormalizedIndex {
  kind: 'index';
  mediaType: string;
  digest: string;
  manifests: Descriptor[];
  raw?: Record<string, unknown>;
  referrers?: Descriptor[];
  referrersSupported?: boolean;
}

export interface NormalizedLegacy {
  kind: 'legacy';
  mediaType: string;
  digest: string;
  raw?: Record<string, unknown>;
  referrers?: Descriptor[];
  referrersSupported?: boolean;
}

export interface NormalizedUnknown {
  kind: 'unknown';
  mediaType: string;
  digest: string;
  raw?: Record<string, unknown>;
  referrers?: Descriptor[];
  referrersSupported?: boolean;
}

export type NormalizedManifest = NormalizedImage | NormalizedIndex | NormalizedLegacy | NormalizedUnknown;

export interface RegistryTagSummary {
  tag: string;
  digest?: string;
  kind?: NormalizedManifest['kind'];
  mediaType?: string;
  size?: number;
  layerCount?: number;
  platformCount?: number;
  created?: string;
  architecture?: string;
  os?: string;
  error?: string;
}

export interface RegistryListResult {
  items: string[];
  nextCursor?: string;
  summaries?: RegistryTagSummary[];
}

export interface RegistryDeleteImpact {
  digest: string;
  tags: string[];
}

export interface RegistryRepositoryManifestImpact {
  digest: string;
  tags: string[];
}

export interface RegistryRepositoryDeleteImpact {
  repository: string;
  tags: string[];
  manifests: RegistryRepositoryManifestImpact[];
  unresolvedTags: string[];
  signature: string;
}

export interface RegistryRepositoryDeleteResult extends RegistryRepositoryDeleteImpact {
  deletedDigests: string[];
}

export interface RegistryTransferResult {
  repository: string;
  tag: string;
  format: RegistryArchiveFormat;
  digest: string;
  uploadedBlobs: number;
  reusedBlobs: number;
  uploadedBytes: number;
}
