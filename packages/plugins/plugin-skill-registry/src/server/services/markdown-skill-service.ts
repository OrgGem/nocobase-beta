import { buildArtifact } from './artifact-builder';
import { candidateDigest } from './canonical-json';
import { RegistryError } from '../contracts/errors';
import type { RegistrySkillManifestV1 } from '../contracts/types';
import { getString, type RegistryModel } from './model-values';
import {
  artifactOperationLockKey,
  packageOperationLockKey,
  runRegistryOperation,
  tryRunRegistryOperation,
  type RegistryOperationLockManager,
} from './operation-lock';
import type { RegistryDatabase } from './repository-types';
import { withTransaction } from './repository-types';
import { SignatureService } from './signature-service';
import { FilesystemArtifactStore } from './filesystem-artifact-store';
import { splitSkillMarkdown, type SkillMarkdownDocument } from './skill-markdown-meta';
import { assertChannel, assertSemver, normalizeIdentity } from './validation';

function modelId(model: RegistryModel): string {
  return getString(model, 'id');
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.name === 'SequelizeUniqueConstraintError';
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function publishLockTtlMs(): number {
  return positiveInteger(process.env.SKILL_REGISTRY_PUBLISH_LOCK_TTL_MS, 10 * 60 * 1000, 60 * 60 * 1000);
}

export interface MarkdownSkillInput {
  namespace: string;
  slug: string;
  displayName: string;
  description?: string;
  content: string;
  tags?: string[];
  visibility?: 'private' | 'shared';
}

export interface MarkdownSkillValues {
  namespace: string;
  slug: string;
  displayName: string;
  description: string;
  content: string;
  tags: string[];
  visibility: 'private' | 'shared';
}

export interface MarkdownSkillVersionSummary {
  id: string;
  version: string;
  channel: string;
  status: string;
  changelog: string | null;
  publishedAt: unknown;
}

export interface MarkdownSkillDetail {
  skill: RegistryModel;
  markdown: SkillMarkdownDocument;
  versions: MarkdownSkillVersionSummary[];
}

export class MarkdownSkillService {
  constructor(
    private readonly database: RegistryDatabase,
    private readonly artifactStore: FilesystemArtifactStore,
    private readonly signatureService: SignatureService,
    private readonly lockManager?: RegistryOperationLockManager,
  ) {}

  private buildCandidate(skill: RegistryModel) {
    const namespace = normalizeIdentity(getString(skill, 'namespace'), 'namespace');
    const slug = normalizeIdentity(getString(skill, 'slug'), 'slug');
    const displayName = getString(skill, 'displayName');
    const description = getString(skill, 'description');
    const tags = normalizeTags(skill.get('tags'));
    const content = getString(skill, 'content');

    if (!content.trim()) {
      throw new RegistryError('INVALID_MARKDOWN_SKILL', 422, 'Markdown skill content is required.');
    }

    const manifest: RegistrySkillManifestV1 = {
      schemaVersion: 'registry.skill.nocobase.io/v1',
      name: `${namespace}/${slug}`,
      displayName,
      description,
      runtime: { kind: 'instruction', entrypoint: 'skill.md' },
      inputSchema: {},
      outputSchema: {},
      permissions: {},
      dependencies: [],
      compatibility: {},
      tags,
    };

    const files = [{ path: 'skill.md', content: Buffer.from(content, 'utf8') }];
    const digest = candidateDigest(manifest, files);

    return {
      contractVersion: 'registry-candidate/v1' as const,
      source: {
        provider: 'skill-hub' as const,
        sourceId: '',
        externalKey: '',
        revision: digest,
      },
      identity: { namespace, slug },
      manifest,
      files,
      candidateDigest: digest,
    };
  }

  private async findPublishedVersion(
    packageId: string,
    version: string,
    transaction?: unknown,
  ): Promise<RegistryModel | null> {
    return this.database.getRepository('skillRegistryVersions').findOne({
      filter: { packageId, version },
      transaction,
    });
  }

  async createSkill(input: MarkdownSkillInput, ownerId: string | number): Promise<RegistryModel> {
    const values = this.normalizeValues(input);
    const existing = await this.database.getRepository('skillRegistryMarkdownSkills').findOne({
      filter: { namespace: values.namespace, slug: values.slug },
    });
    if (existing) {
      throw new RegistryError(
        'MARKDOWN_SKILL_EXISTS',
        409,
        'A markdown skill with this namespace and slug already exists.',
      );
    }
    return this.database.getRepository('skillRegistryMarkdownSkills').create({
      values: {
        ...values,
        ownerId,
        status: 'draft',
      },
    });
  }

  async updateSkill(
    id: string | number,
    input: Partial<MarkdownSkillInput>,
    ownerId: string | number,
  ): Promise<RegistryModel> {
    const skill = await this.database.getRepository('skillRegistryMarkdownSkills').findOne({ filterByTk: id });
    if (!skill) {
      throw new RegistryError('MARKDOWN_SKILL_NOT_FOUND', 404, 'Markdown skill was not found.');
    }
    if (String(skill.get('ownerId')) !== String(ownerId)) {
      throw new RegistryError('FORBIDDEN', 403, 'Only the owner can update this markdown skill.');
    }
    const values: Partial<MarkdownSkillValues> = {};
    if (input.namespace !== undefined) {
      values.namespace = normalizeIdentity(input.namespace, 'namespace');
    }
    if (input.slug !== undefined) {
      values.slug = normalizeIdentity(input.slug, 'slug');
    }
    if (input.displayName !== undefined) {
      values.displayName = input.displayName.trim();
    }
    if (input.description !== undefined) {
      values.description = input.description;
    }
    if (input.content !== undefined) {
      values.content = input.content;
    }
    if (input.tags !== undefined) {
      values.tags = input.tags;
    }
    if (input.visibility !== undefined) {
      values.visibility = input.visibility;
    }
    return this.database.getRepository('skillRegistryMarkdownSkills').update({
      filterByTk: id,
      values,
    });
  }

  async deleteSkill(id: string | number, ownerId: string | number): Promise<void> {
    const skill = await this.database.getRepository('skillRegistryMarkdownSkills').findOne({ filterByTk: id });
    if (!skill) {
      throw new RegistryError('MARKDOWN_SKILL_NOT_FOUND', 404, 'Markdown skill was not found.');
    }
    if (String(skill.get('ownerId')) !== String(ownerId)) {
      throw new RegistryError('FORBIDDEN', 403, 'Only the owner can delete this markdown skill.');
    }
    await this.database.getRepository('skillRegistryMarkdownSkills').destroy({ filterByTk: id });
  }

  async getSkill(id: string | number, userId?: string | number): Promise<RegistryModel> {
    const skill = await this.database.getRepository('skillRegistryMarkdownSkills').findOne({
      filterByTk: id,
      appends: ['owner'],
    });
    if (!skill) {
      throw new RegistryError('MARKDOWN_SKILL_NOT_FOUND', 404, 'Markdown skill was not found.');
    }
    if (userId !== undefined && !(await this.canAccessSkill(skill, userId))) {
      throw new RegistryError('FORBIDDEN', 403, 'You do not have access to this markdown skill.');
    }
    return skill;
  }

  async getSkillDetail(id: string | number, userId?: string | number): Promise<MarkdownSkillDetail> {
    const skill = await this.getSkill(id, userId);
    const markdown = splitSkillMarkdown(getString(skill, 'content'));
    const packageId = skill.get('packageId');
    const versionRows = packageId
      ? await this.database.getRepository('skillRegistryVersions').find({
          filter: { packageId },
          sort: ['-publishedAt', '-id'],
        })
      : [];
    const versions = versionRows.map((version) => ({
      id: modelId(version),
      version: getString(version, 'version'),
      channel: getString(version, 'channel'),
      status: getString(version, 'status'),
      changelog: getString(version, 'changelog') || null,
      publishedAt: version.get('publishedAt'),
    }));
    return { skill, markdown, versions };
  }

  async publish(input: {
    markdownSkillId: string | number;
    version: string;
    channel?: string;
    changelog?: string;
    publishedById?: string | number;
  }): Promise<RegistryModel> {
    const skill = await this.database.getRepository('skillRegistryMarkdownSkills').findOne({
      filterByTk: input.markdownSkillId,
    });
    if (!skill) {
      throw new RegistryError('MARKDOWN_SKILL_NOT_FOUND', 404, 'Markdown skill was not found.');
    }

    const candidate = this.buildCandidate(skill);
    const version = assertSemver(input.version);
    const channel = assertChannel(input.channel || 'stable');
    const namespace = candidate.identity.namespace;
    const slug = candidate.identity.slug;

    const attempted = await tryRunRegistryOperation(
      this.lockManager,
      packageOperationLockKey(namespace, slug),
      publishLockTtlMs(),
      () => this.publishWithLock(skill, candidate, version, channel, input.changelog, input.publishedById),
    );

    if (!attempted.acquired) {
      throw new RegistryError(
        'REGISTRY_OPERATION_BUSY',
        409,
        'This skill is currently being published. Retry the request.',
      );
    }

    const createdVersion = attempted.value;

    await this.database.getRepository('skillRegistryMarkdownSkills').update({
      filterByTk: modelId(skill),
      values: { status: 'published' },
    });

    return createdVersion;
  }

  private async publishWithLock(
    skill: RegistryModel,
    candidate: ReturnType<typeof this.buildCandidate>,
    version: string,
    channel: string,
    changelog: string | undefined,
    publishedById: string | number | undefined,
  ): Promise<RegistryModel> {
    const namespace = candidate.identity.namespace;
    const slug = candidate.identity.slug;
    const packageName = `${namespace}/${slug}`;

    return runRegistryOperation(
      this.lockManager,
      artifactOperationLockKey(candidate.candidateDigest),
      publishLockTtlMs(),
      async () => {
        return withTransaction(this.database, async (transaction) => {
          const packages = this.database.getRepository('skillRegistryPackages');
          let packageRecord = await packages.findOne({ filter: { namespace, slug }, transaction });

          if (packageRecord) {
            const ownerId = packageRecord.get('ownerId');
            if (ownerId && String(ownerId) !== String(skill.get('ownerId'))) {
              throw new RegistryError(
                'PACKAGE_IDENTITY_COLLISION',
                409,
                'This package identity is already owned by another user.',
              );
            }
          } else {
            packageRecord = await packages.create({
              transaction,
              values: {
                namespace,
                slug,
                displayName: candidate.manifest.displayName,
                description: candidate.manifest.description,
                tags: candidate.manifest.tags,
                visibility: getString(skill, 'visibility') || 'shared',
                status: 'draft',
                defaultChannel: 'stable',
                ownerId: skill.get('ownerId'),
              },
            });
          }

          const packageId = modelId(packageRecord);

          const existingVersion = await this.findPublishedVersion(packageId, version, transaction);
          if (existingVersion) {
            if (getString(existingVersion, 'candidateDigest') === candidate.candidateDigest) {
              return existingVersion;
            }
            throw new RegistryError(
              'VERSION_IMMUTABLE',
              409,
              `Version ${version} already exists with different content.`,
            );
          }

          const artifact = buildArtifact({ ...candidate, manifest: candidate.manifest });
          const targetStorageKey = this.artifactStore.keyForDigestGeneration(artifact.digest);
          const storedArtifact = await this.artifactStore.putAt(targetStorageKey, artifact.digest, artifact.content);

          try {
            const signature = this.signatureService.signEnvelope({
              packageName,
              version,
              manifestDigest: artifact.manifestDigest,
              artifactDigest: artifact.digest,
            });

            const artifacts = this.database.getRepository('skillRegistryArtifacts');
            let artifactRecord = await artifacts.findOne({ filter: { digest: artifact.digest }, transaction });
            if (!artifactRecord) {
              artifactRecord = await artifacts.create({
                transaction,
                values: {
                  digest: artifact.digest,
                  storageDriver: 'filesystem',
                  storageKey: storedArtifact.storageKey,
                  format: 'zip',
                  contentType: 'application/zip',
                  sizeBytes: storedArtifact.sizeBytes,
                  expandedSizeBytes: artifact.expandedSizeBytes,
                  manifestDigest: artifact.manifestDigest,
                  verificationStatus: 'verified',
                },
              });
            }

            const versions = this.database.getRepository('skillRegistryVersions');
            const createdVersion = await versions.create({
              transaction,
              values: {
                packageId,
                sourceItemId: null,
                version,
                channel,
                status: 'published',
                sourceRevision: candidate.candidateDigest,
                candidateDigest: candidate.candidateDigest,
                manifest: candidate.manifest,
                manifestDigest: artifact.manifestDigest,
                runtime: candidate.manifest.runtime.kind,
                entrypoint: candidate.manifest.runtime.entrypoint,
                permissions: candidate.manifest.permissions,
                dependencies: candidate.manifest.dependencies,
                compatibility: candidate.manifest.compatibility,
                changelog: changelog || null,
                artifactId: modelId(artifactRecord),
                artifactDigest: artifact.digest,
                registrySignature: signature,
                signatureKeyId: signature ? this.signatureService.keyId : null,
                validationReport: { artifact: 'verified' },
                publishedById: publishedById ?? null,
                publishedAt: new Date(),
              },
            });

            const packageValues: Record<string, unknown> = {
              status: 'published',
              publishedAt: packageRecord.get('publishedAt') || new Date(),
              displayName: candidate.manifest.displayName,
              description: candidate.manifest.description,
              tags: candidate.manifest.tags,
              visibility: getString(skill, 'visibility') || 'shared',
              ownerId: skill.get('ownerId'),
            };
            if (channel === 'stable') {
              packageValues.latestStableVersionId = modelId(createdVersion);
            }
            await packages.update({ filterByTk: packageId, values: packageValues, transaction });

            await this.database.getRepository('skillRegistryMarkdownSkills').update({
              filterByTk: modelId(skill),
              values: { packageId, status: 'published' },
              transaction,
            });

            return createdVersion;
          } catch (error) {
            const tracked = await this.database.getRepository('skillRegistryArtifacts').findOne({
              filter: { digest: artifact.digest },
            });
            if (!tracked) {
              await this.artifactStore.remove(storedArtifact.storageKey).catch(() => undefined);
            }
            if (isUniqueConstraintError(error)) {
              const raced = await this.findPublishedVersion(packageId, version, transaction);
              if (raced && getString(raced, 'candidateDigest') === candidate.candidateDigest) {
                return raced;
              }
              throw new RegistryError(
                'VERSION_IMMUTABLE',
                409,
                `Version ${version} conflicts with an existing version.`,
              );
            }
            throw error;
          }
        });
      },
    );
  }

  async share(markdownSkillId: string | number, userId: string | number, sharedById: string | number): Promise<void> {
    const skill = await this.getSkill(markdownSkillId, sharedById);
    const packageId = skill.get('packageId');
    if (!packageId) {
      throw new RegistryError('MARKDOWN_SKILL_NOT_PUBLISHED', 409, 'Skill must be published before sharing.');
    }
    const existing = await this.database.getRepository('skillRegistryPackageShares').findOne({
      filter: { packageId, userId },
    });
    if (existing) {
      return;
    }
    await this.database.getRepository('skillRegistryPackageShares').create({
      values: { packageId, userId },
    });
  }

  async unshare(markdownSkillId: string | number, userId: string | number, sharedById: string | number): Promise<void> {
    const skill = await this.getSkill(markdownSkillId, sharedById);
    const packageId = skill.get('packageId');
    if (!packageId) {
      return;
    }
    await this.database.getRepository('skillRegistryPackageShares').destroy({
      filter: { packageId, userId },
    });
  }

  async listShares(markdownSkillId: string | number, ownerId: string | number): Promise<RegistryModel[]> {
    const skill = await this.getSkill(markdownSkillId, ownerId);
    const packageId = skill.get('packageId');
    if (!packageId) {
      return [];
    }
    return this.database.getRepository('skillRegistryPackageShares').find({
      filter: { packageId },
      appends: ['user'],
    });
  }

  private normalizeValues(input: MarkdownSkillInput): MarkdownSkillValues {
    return {
      namespace: normalizeIdentity(input.namespace, 'namespace'),
      slug: normalizeIdentity(input.slug, 'slug'),
      displayName: input.displayName.trim(),
      description: input.description?.trim() || '',
      content: input.content,
      tags: normalizeTags(input.tags),
      visibility: input.visibility === 'private' ? 'private' : 'shared',
    };
  }

  private async canAccessSkill(skill: RegistryModel, userId: string | number): Promise<boolean> {
    if (String(skill.get('ownerId')) === String(userId)) {
      return true;
    }
    const visibility = getString(skill, 'visibility') || 'shared';
    if (visibility === 'private') {
      return false;
    }
    const packageId = skill.get('packageId');
    if (!packageId) {
      return false;
    }
    const share = await this.database.getRepository('skillRegistryPackageShares').findOne({
      filter: { packageId, userId },
    });
    return Boolean(share);
  }

  async listOwnSkills(
    userId: string | number,
    page: number,
    pageSize: number,
  ): Promise<{ rows: RegistryModel[]; count: number }> {
    const repository = this.database.getRepository('skillRegistryMarkdownSkills');
    const rows = await repository.find({
      filter: { ownerId: userId },
      sort: ['-updatedAt'],
      page,
      pageSize,
    });
    const count = await repository.count({ filter: { ownerId: userId } });
    return { rows, count };
  }
}
