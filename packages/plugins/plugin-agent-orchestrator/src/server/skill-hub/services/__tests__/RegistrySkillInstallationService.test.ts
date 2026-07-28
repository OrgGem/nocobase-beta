import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { Database } from '@nocobase/database';

import { SkillRepositoryService } from '../../../services/SkillRepositoryService';
import { RegistrySkillInstallationService, type RegistryInstallationInput } from '../RegistrySkillInstallationService';

function model(values: Record<string, unknown>) {
  return { get: (attribute: string) => values[attribute] };
}

function installationInput(): RegistryInstallationInput {
  return {
    registryPackageId: 'package-1',
    registryVersionId: 'version-2',
    packageIdentity: 'acme/report',
    version: '2.0.0',
    channel: 'stable',
    artifactDigest: `sha256:${'a'.repeat(64)}`,
    sourceSignature: null,
    updatePolicy: 'pinned',
    runtime: 'python',
    codeTemplate: 'print("new")\n',
    entrypoint: 'src/index.py',
    files: [
      { path: 'SKILL.md', content: Buffer.from('# Report\n') },
      { path: 'src/index.py', content: Buffer.from('print("new")\n') },
    ],
    instructions: 'Generate a report.',
    inputSchema: { type: 'object', properties: {} },
    dependencies: [],
  };
}

describe('RegistrySkillInstallationService', () => {
  let storagePath = '';
  let repository: SkillRepositoryService;

  beforeEach(() => {
    storagePath = mkdtempSync(join(tmpdir(), 'registry-installation-service-'));
    repository = new SkillRepositoryService(storagePath);
    repository.writeSkillPackage('registry-acme-report', [
      { path: 'SKILL.md', content: Buffer.from('# Report\n') },
      { path: 'src/index.py', content: Buffer.from('print("old")\n') },
    ]);
  });

  afterEach(() => {
    rmSync(storagePath, { recursive: true, force: true });
  });

  it('returns only the previous version of an active registry installation as a rollback target', async () => {
    const current = model({
      id: 'installation-2',
      status: 'installed',
      previousInstallationId: 'installation-1',
    });
    const previous = model({
      id: 'installation-1',
      registryVersionId: 'version-1',
      updatePolicy: 'channel',
    });
    const installations = {
      findOne: vi
        .fn()
        .mockImplementation(async ({ filterByTk }: { filterByTk: string }) =>
          filterByTk === 'installation-2' ? current : filterByTk === 'installation-1' ? previous : null,
        ),
    };
    const database = {
      getRepository(name: string) {
        if (name !== 'skillRegistryInstallations') {
          throw new Error(`Unexpected repository ${name}`);
        }
        return installations;
      },
    } as unknown as Database;
    const service = new RegistrySkillInstallationService(database, () => repository);

    await expect(service.getRollbackTarget('installation-2')).resolves.toEqual({
      registryVersionId: 'version-1',
      updatePolicy: 'channel',
    });
  });

  it('keeps the existing package bytes when an upgrade transaction fails', async () => {
    const previousInstallation = model({ id: 'installation-1', skillDefinitionId: 'skill-1', status: 'installed' });
    const skill = model({ id: 'skill-1', name: 'registry-acme-report', toolName: 'registry_acme_report' });
    const installations = {
      findOne: vi
        .fn()
        .mockImplementation(async ({ filter }: { filter: Record<string, unknown> }) =>
          filter.registryVersionId ? null : previousInstallation,
        ),
      create: vi.fn().mockRejectedValue(new Error('database write failed')),
      update: vi.fn().mockResolvedValue(undefined),
    };
    const skillDefinitions = {
      findOne: vi.fn().mockResolvedValue(skill),
      update: vi.fn().mockResolvedValue(undefined),
    };
    const database = {
      getRepository(name: string) {
        return { skillRegistryInstallations: installations, skillDefinitions }[name];
      },
      sequelize: { transaction: async <T>(callback: (transaction: object) => Promise<T>) => callback({}) },
    } as unknown as Database;
    const service = new RegistrySkillInstallationService(database, () => repository);

    await expect(service.installRegistryVersion(installationInput())).rejects.toThrow('database write failed');
    expect(readFileSync(join(repository.getSkillPath('registry-acme-report'), 'src', 'index.py'), 'utf8')).toContain(
      'old',
    );
  });

  it('updates the existing local projection without changing its tool identity', async () => {
    const previousInstallation = model({ id: 'installation-1', skillDefinitionId: 'skill-1', status: 'installed' });
    const newInstallation = model({ id: 'installation-2' });
    const skill = model({ id: 'skill-1', name: 'registry-acme-report', toolName: 'registry_acme_report' });
    const installations = {
      findOne: vi
        .fn()
        .mockImplementation(async ({ filter }: { filter: Record<string, unknown> }) =>
          filter.registryVersionId ? null : previousInstallation,
        ),
      create: vi.fn().mockResolvedValue(newInstallation),
      update: vi.fn().mockResolvedValue(undefined),
    };
    const skillDefinitions = {
      findOne: vi.fn().mockResolvedValue(skill),
      update: vi.fn().mockResolvedValue(undefined),
    };
    const database = {
      getRepository(name: string) {
        return { skillRegistryInstallations: installations, skillDefinitions }[name];
      },
      sequelize: { transaction: async <T>(callback: (transaction: object) => Promise<T>) => callback({}) },
    } as unknown as Database;
    const service = new RegistrySkillInstallationService(database, () => repository);

    await expect(service.installRegistryVersion(installationInput())).resolves.toEqual({
      installationId: 'installation-2',
      skillDefinitionId: 'skill-1',
      toolName: 'registry_acme_report',
      status: 'installed',
    });
    expect(skillDefinitions.update).toHaveBeenCalledWith(
      expect.objectContaining({
        filterByTk: 'skill-1',
        values: expect.objectContaining({ enabled: false, registryVersionId: 'version-2' }),
      }),
    );
    expect(readFileSync(join(repository.getSkillPath('registry-acme-report'), 'src', 'index.py'), 'utf8')).toContain(
      'new',
    );
  });
});
