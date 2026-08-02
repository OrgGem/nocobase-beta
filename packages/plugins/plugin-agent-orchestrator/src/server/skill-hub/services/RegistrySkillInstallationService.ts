import { createHash } from 'crypto';

import type { Database } from '@nocobase/database';

import type { SkillRepositoryService } from '../../services/SkillRepositoryService';
import { assertSkillToolNameAvailable, buildSkillToolName } from '../../utils/skill-tool-name';

export interface RegistryInstallationInput {
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
}

export interface RegistryInstallationResult {
  installationId: string;
  skillDefinitionId: string;
  toolName: string;
  status: 'installed';
}

export interface RegistryRollbackTarget {
  registryVersionId: string;
  updatePolicy: 'pinned' | 'channel';
}

export interface RegistryInstallationState {
  installationId: string;
  registryPackageId: string;
  registryVersionId: string;
  skillDefinitionId: string;
  version: string;
  updatePolicy: 'pinned' | 'channel';
  status: string;
  installedAt: string | null;
}

type Model = {
  get(attribute: string): unknown;
};

function read(model: Model, attribute: string, fallback = ''): string {
  const value = model.get(attribute);
  return typeof value === 'string' ? value : value === null || value === undefined ? fallback : String(value);
}

function localSkillName(packageIdentity: string): string {
  const normalizedIdentity = packageIdentity
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const readablePrefix = normalizedIdentity ? `registry-${normalizedIdentity}` : 'registry';
  const suffix = createHash('sha256').update(packageIdentity).digest('hex').slice(0, 12);
  return `${readablePrefix.slice(0, 87)}-${suffix}`;
}

function jsonText(value: unknown, fallback: unknown): string {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function executionWrapper(runtime: 'python' | 'node', entrypoint: string): string {
  const serializedEntrypoint = JSON.stringify(entrypoint);
  if (runtime === 'python') {
    return [
      'import os',
      'import runpy',
      `runpy.run_path(os.path.join(os.environ['SKILL_DIR'], ${serializedEntrypoint}), run_name='__main__')`,
      '',
    ].join('\n');
  }
  return `require(require('path').join(process.env.SKILL_DIR, ${serializedEntrypoint}));\n`;
}

export class RegistrySkillInstallationService {
  constructor(
    private readonly database: Database,
    private readonly getSkillRepository: () => SkillRepositoryService,
  ) {}

  async getRegistryInstallationStates(
    registryVersionIds: Array<string | number>,
  ): Promise<RegistryInstallationState[]> {
    if (registryVersionIds.length === 0) return [];
    const installations = await this.database.getRepository('skillRegistryInstallations').find({
      filter: { registryVersionId: { $in: registryVersionIds } },
      sort: ['-installedAt', '-id'],
    });
    return installations.map((installation) => {
      const record = installation as unknown as Model;
      const installedAt = installation.get('installedAt');
      return {
        installationId: read(record, 'id'),
        registryPackageId: read(record, 'registryPackageId'),
        registryVersionId: read(record, 'registryVersionId'),
        skillDefinitionId: read(record, 'skillDefinitionId'),
        version: read(record, 'version'),
        updatePolicy: read(record, 'updatePolicy') === 'channel' ? 'channel' : 'pinned',
        status: read(record, 'status'),
        installedAt: installedAt instanceof Date ? installedAt.toISOString() : installedAt ? String(installedAt) : null,
      };
    });
  }

  async getRollbackTarget(installationId: string | number): Promise<RegistryRollbackTarget | null> {
    const installations = this.database.getRepository('skillRegistryInstallations');
    const installation = await installations.findOne({ filterByTk: installationId });
    if (!installation || read(installation as unknown as Model, 'status') !== 'installed') {
      return null;
    }
    const previousInstallationId = read(installation as unknown as Model, 'previousInstallationId');
    if (!previousInstallationId) {
      return null;
    }
    const previous = await installations.findOne({ filterByTk: previousInstallationId });
    if (!previous) {
      return null;
    }
    const registryVersionId = read(previous as unknown as Model, 'registryVersionId');
    if (!registryVersionId) {
      return null;
    }
    return {
      registryVersionId,
      updatePolicy: read(previous as unknown as Model, 'updatePolicy') === 'channel' ? 'channel' : 'pinned',
    };
  }

  async installRegistryVersion(input: RegistryInstallationInput): Promise<RegistryInstallationResult> {
    const installations = this.database.getRepository('skillRegistryInstallations');
    const existing = await installations.findOne({ filter: { registryVersionId: input.registryVersionId } });
    if (existing && read(existing as unknown as Model, 'status') === 'installed') {
      const skillDefinitionId = read(existing as unknown as Model, 'skillDefinitionId');
      const skill = await this.database.getRepository('skillDefinitions').findOne({ filterByTk: skillDefinitionId });
      if (!skill) {
        throw new Error('Existing registry installation has no skill definition.');
      }
      return {
        installationId: read(existing as unknown as Model, 'id'),
        skillDefinitionId,
        toolName: read(skill as unknown as Model, 'toolName'),
        status: 'installed',
      };
    }

    const previous = await installations.findOne({
      filter: { registryPackageId: input.registryPackageId, status: 'installed' },
      sort: ['-installedAt', '-id'],
    });
    const skillDefinitions = this.database.getRepository('skillDefinitions');
    const previousSkillDefinitionId = previous ? read(previous as unknown as Model, 'skillDefinitionId') : '';
    let skill = previousSkillDefinitionId
      ? await skillDefinitions.findOne({ filterByTk: previousSkillDefinitionId })
      : null;
    const name = skill ? read(skill as unknown as Model, 'name') : localSkillName(input.packageIdentity);
    if (!input.codeTemplate.trim()) {
      throw new Error('Registry artifact entrypoint is empty.');
    }
    const skillRepository = this.getSkillRepository();
    const previousPackage = skillRepository.readSkillPackageFiles(name);
    const values = {
      title: input.packageIdentity,
      description: `Registry package ${input.packageIdentity}@${input.version}`,
      instructions: input.instructions,
      language: input.runtime,
      codeTemplate: executionWrapper(input.runtime, input.entrypoint),
      inputSchema: jsonText(input.inputSchema, { type: 'object', properties: {} }),
      packages: jsonText(input.dependencies, []),
      storageType: 'local',
      storageUrl: `local://registry/${name}`,
      enabled: false,
      toolScope: 'CUSTOM',
      autoCall: false,
      registryPackageId: input.registryPackageId,
      registryVersionId: input.registryVersionId,
      registryChannel: input.channel,
      sourceDigest: input.artifactDigest,
      sourceSignature: input.sourceSignature,
      registryInstallStatus: 'installed',
      registryUpdatePolicy: input.updatePolicy,
    };

    if (!skill) {
      const toolName = buildSkillToolName(name);
      await assertSkillToolNameAvailable(this.database, toolName);
    }
    skillRepository.writeSkillPackage(name, input.files);
    try {
      return await this.database.sequelize.transaction(async (transaction) => {
        if (!skill) {
          const toolName = buildSkillToolName(name);
          skill = await skillDefinitions.create({ values: { name, toolName, ...values }, transaction });
        } else {
          await skillDefinitions.update({
            filterByTk: read(skill as unknown as Model, 'id'),
            values,
            transaction,
          });
          skill = await skillDefinitions.findOne({ filterByTk: read(skill as unknown as Model, 'id'), transaction });
        }
        if (!skill) {
          throw new Error('Failed to materialize the registry skill definition.');
        }

        const installationValues = {
          registryPackageId: input.registryPackageId,
          registryVersionId: input.registryVersionId,
          packageIdentity: input.packageIdentity,
          version: input.version,
          channel: input.channel,
          artifactDigest: input.artifactDigest,
          sourceSignature: input.sourceSignature,
          updatePolicy: input.updatePolicy,
          status: 'installed',
          skillDefinitionId: read(skill as unknown as Model, 'id'),
          previousInstallationId: previous ? read(previous as unknown as Model, 'id') : null,
          installedAt: new Date(),
          installedById: input.installedById || null,
          lastError: null,
        };
        let installation = existing;
        if (installation) {
          await installations.update({
            filterByTk: read(installation as unknown as Model, 'id'),
            values: installationValues,
            transaction,
          });
          installation = await installations.findOne({
            filterByTk: read(installation as unknown as Model, 'id'),
            transaction,
          });
        } else {
          installation = await installations.create({ values: installationValues, transaction });
        }
        if (!installation) {
          throw new Error('Failed to persist the registry installation.');
        }
        await skillDefinitions.update({
          filterByTk: read(skill as unknown as Model, 'id'),
          values: { registryInstallationId: read(installation as unknown as Model, 'id') },
          transaction,
        });
        if (previous) {
          await installations.update({
            filterByTk: read(previous as unknown as Model, 'id'),
            values: { status: 'rolled_back' },
            transaction,
          });
        }
        return {
          installationId: read(installation as unknown as Model, 'id'),
          skillDefinitionId: read(skill as unknown as Model, 'id'),
          toolName: read(skill as unknown as Model, 'toolName'),
          status: 'installed' as const,
        };
      });
    } catch (error) {
      if (previousPackage) {
        skillRepository.writeSkillPackage(name, previousPackage);
      } else {
        skillRepository.removeSkillPackage(name);
      }
      throw error;
    }
  }
}
