import { unpackArtifact } from './artifact-builder';
import { RegistryError } from '../contracts/errors';
import type { FilesystemArtifactStore } from './filesystem-artifact-store';
import { getString, type RegistryModel } from './model-values';
import type { RegistryDatabase } from './repository-types';
import { splitSkillMarkdown, type SkillMarkdownDocument } from './skill-markdown-meta';

export interface CatalogVersionSummary {
  id: string;
  version: string;
  channel: string;
  status: string;
  changelog: string | null;
  publishedAt: unknown;
}

export interface CatalogSkillDetail {
  skill: RegistryModel;
  markdown: SkillMarkdownDocument | null;
  versions: CatalogVersionSummary[];
}

function modelId(model: RegistryModel): string {
  return getString(model, 'id');
}

function findSkillMarkdown(files: Map<string, Buffer>): Buffer | undefined {
  // Git sources publish SKILL.md while in-app markdown skills publish skill.md,
  // so match the instruction file case-insensitively.
  for (const [path, content] of files) {
    if (path.toLowerCase() === 'skill.md') {
      return content;
    }
  }
  return undefined;
}

export class CatalogSkillDetailService {
  constructor(
    private readonly database: RegistryDatabase,
    private readonly artifactStore: FilesystemArtifactStore,
  ) {}

  async getPackageDetail(packageId: string | number): Promise<CatalogSkillDetail> {
    const packageRecord = await this.database.getRepository('skillRegistryPackages').findOne({
      filterByTk: packageId,
      appends: ['owner'],
    });
    if (!packageRecord) {
      throw new RegistryError('PACKAGE_NOT_FOUND', 404, 'Package was not found.');
    }
    const resolvedPackageId = modelId(packageRecord);
    const versionRows = await this.database.getRepository('skillRegistryVersions').find({
      filter: { packageId: resolvedPackageId },
      sort: ['-publishedAt', '-id'],
    });
    const versions = versionRows.map((version) => ({
      id: modelId(version),
      version: getString(version, 'version'),
      channel: getString(version, 'channel'),
      status: getString(version, 'status'),
      changelog: getString(version, 'changelog') || null,
      publishedAt: version.get('publishedAt'),
    }));

    const sourceVersion = this.selectSourceVersion(packageRecord, versionRows);
    const markdown = sourceVersion ? await this.extractSkillMarkdown(sourceVersion) : null;

    return { skill: packageRecord, markdown, versions };
  }

  private selectSourceVersion(packageRecord: RegistryModel, versionRows: RegistryModel[]): RegistryModel | undefined {
    const latestStableVersionId = packageRecord.get('latestStableVersionId');
    if (latestStableVersionId !== null && latestStableVersionId !== undefined && latestStableVersionId !== '') {
      const pointed = versionRows.find((version) => String(version.get('id')) === String(latestStableVersionId));
      if (pointed) {
        return pointed;
      }
    }
    return versionRows.find((version) => getString(version, 'status') === 'published');
  }

  private async extractSkillMarkdown(version: RegistryModel): Promise<SkillMarkdownDocument | null> {
    const artifact = await this.database.getRepository('skillRegistryArtifacts').findOne({
      filterByTk: getString(version, 'artifactId'),
    });
    if (!artifact || getString(artifact, 'verificationStatus') !== 'verified') {
      return null;
    }
    const storageKey = getString(artifact, 'storageKey');
    const digest = getString(artifact, 'digest');
    const sizeBytes = Number(artifact.get('sizeBytes'));
    const content = await this.artifactStore.readVerified(
      storageKey,
      digest,
      Number.isSafeInteger(sizeBytes) && sizeBytes >= 0 ? sizeBytes : undefined,
    );
    const { files } = unpackArtifact(content);
    const skillMarkdown = findSkillMarkdown(files);
    if (!skillMarkdown) {
      return null;
    }
    return splitSkillMarkdown(skillMarkdown.toString('utf8'));
  }
}
