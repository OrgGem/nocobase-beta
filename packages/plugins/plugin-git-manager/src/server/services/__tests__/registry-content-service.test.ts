import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { Database } from '@nocobase/database';

import {
  RegistryGitContentService,
  SkillHubGitContentService,
  type RegistryGitAccessContext,
} from '../registry-content-service';

const scheduledSyncAccess: RegistryGitAccessContext = { kind: 'system', reason: 'scheduled-sync' };

describe('RegistryGitContentService', () => {
  const originalRepositoryRoot = process.env.GIT_REPOS_BASE_PATH;
  let repositoryRoot = '';
  let repositoryPath = '';
  let commitSha = '';

  beforeEach(() => {
    repositoryRoot = mkdtempSync(join(tmpdir(), 'registry-git-content-'));
    repositoryPath = join(repositoryRoot, 'skills');
    mkdirSync(repositoryPath, { recursive: true });
    process.env.GIT_REPOS_BASE_PATH = repositoryRoot;
    execFileSync('git', ['init', repositoryPath], { stdio: 'ignore' });
    execFileSync('git', ['-C', repositoryPath, 'config', 'user.email', 'registry@example.test'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repositoryPath, 'config', 'user.name', 'Registry Test'], { stdio: 'ignore' });
    writeFileSync(join(repositoryPath, 'payload.bin'), Buffer.from([0, 255, 128, 17]));
    execFileSync('git', ['-C', repositoryPath, 'add', 'payload.bin'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repositoryPath, 'commit', '-m', 'binary payload'], { stdio: 'ignore' });
    commitSha = execFileSync('git', ['-C', repositoryPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  });

  afterEach(() => {
    rmSync(repositoryRoot, { recursive: true, force: true });
    if (originalRepositoryRoot === undefined) {
      delete process.env.GIT_REPOS_BASE_PATH;
    } else {
      process.env.GIT_REPOS_BASE_PATH = originalRepositoryRoot;
    }
  });

  it('preserves binary skill files when reading from a pinned commit', async () => {
    const database = {
      getRepository: () => ({
        findOne: vi.fn().mockResolvedValue({
          get: (attribute: string) => {
            if (attribute === 'localPath') {
              return 'skills';
            }
            if (attribute === 'registryExportEnabled') {
              return true;
            }
            return null;
          },
        }),
      }),
    } as unknown as Database;
    const service = new RegistryGitContentService(database);

    await expect(
      service.readFile({ repositoryId: 1, commitSha, filePath: 'payload.bin' }, scheduledSyncAccess),
    ).resolves.toEqual(Buffer.from([0, 255, 128, 17]));
    await expect(
      service.readFile({ repositoryId: 1, commitSha, filePath: 'missing.json' }, scheduledSyncAccess),
    ).rejects.toMatchObject({
      code: 'REGISTRY_GIT_FILE_NOT_FOUND',
    });
  });

  it('rejects repository reads unless Git Manager explicitly grants registry export', async () => {
    const database = {
      getRepository: () => ({
        findOne: vi.fn().mockResolvedValue({
          get: (attribute: string) => (attribute === 'registryExportEnabled' ? false : 'skills'),
        }),
      }),
    } as unknown as Database;
    const service = new RegistryGitContentService(database);

    await expect(service.resolveCommit(1, 'HEAD', scheduledSyncAccess)).rejects.toMatchObject({
      code: 'REGISTRY_EXPORT_NOT_GRANTED',
    });
    await expect(
      service.readFile({ repositoryId: 1, commitSha, filePath: 'payload.bin' }, scheduledSyncAccess),
    ).rejects.toMatchObject({
      code: 'REGISTRY_EXPORT_NOT_GRANTED',
    });
  });

  it('does not distinguish a missing repository from an ungranted repository', async () => {
    const database = {
      getRepository: () => ({ findOne: vi.fn().mockResolvedValue(null) }),
    } as unknown as Database;
    const service = new RegistryGitContentService(database);

    await expect(service.resolveCommit(404, 'HEAD', scheduledSyncAccess)).rejects.toMatchObject({
      code: 'REGISTRY_EXPORT_NOT_GRANTED',
    });
  });

  it('waits for a killed Git process to close before returning an output-limit error', async () => {
    // Keep Git writing after the first stdout chunk. This makes the test cover
    // the Windows handle race: the repository must be removable immediately
    // after `readFile()` rejects, without depending on afterEach timing.
    writeFileSync(join(repositoryPath, 'payload.bin'), Buffer.alloc(8 * 1024 * 1024, 255));
    execFileSync('git', ['-C', repositoryPath, 'add', 'payload.bin'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repositoryPath, 'commit', '--amend', '--no-edit'], { stdio: 'ignore' });
    commitSha = execFileSync('git', ['-C', repositoryPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const database = {
      getRepository: () => ({
        findOne: vi.fn().mockResolvedValue({
          get: (attribute: string) => {
            if (attribute === 'localPath') {
              return 'skills';
            }
            if (attribute === 'registryExportEnabled') {
              return true;
            }
            return null;
          },
        }),
      }),
    } as unknown as Database;
    const service = new RegistryGitContentService(database, {
      maxFileBytes: 2,
      maxTreeEntries: 10,
      maxTreeOutputBytes: 1024,
    });

    await expect(
      service.readFile({ repositoryId: 1, commitSha, filePath: 'payload.bin' }, scheduledSyncAccess),
    ).rejects.toThrow('Git file exceeds the registry source-file limit.');
    expect(() => rmSync(repositoryRoot, { recursive: true, force: true, maxRetries: 0 })).not.toThrow();
  });

  it('rejects a Git tree that exceeds the configured entry limit', async () => {
    const database = {
      getRepository: () => ({
        findOne: vi.fn().mockResolvedValue({
          get: (attribute: string) => {
            if (attribute === 'localPath') {
              return 'skills';
            }
            if (attribute === 'registryExportEnabled') {
              return true;
            }
            return null;
          },
        }),
      }),
    } as unknown as Database;
    const service = new RegistryGitContentService(database, {
      maxFileBytes: 1024,
      maxTreeEntries: 0,
      maxTreeOutputBytes: 1024,
    });

    await expect(
      service.listTree({ repositoryId: 1, commitSha, rootPath: '', recursive: true }, scheduledSyncAccess),
    ).rejects.toThrow('Git tree contains too many entries for registry export.');
  });

  it('requires an explicit actor instead of treating an internal call as a system sync', async () => {
    const database = {
      getRepository: vi.fn(),
    } as unknown as Database;
    const service = new RegistryGitContentService(database);

    expect(service.contractVersion).toBe(2);
    expect(service.capabilities).toEqual(
      expect.arrayContaining(['registry-content-with-actor', 'registry-content-authorize-source']),
    );
    await expect(service.assertRepositoryAccess(1)).rejects.toMatchObject({
      code: 'REGISTRY_REPOSITORY_ACCESS_DENIED',
    });
    expect(database.getRepository).not.toHaveBeenCalled();
  });

  it('allows a user whose Git Manager file-content scope includes the repository', async () => {
    const acl = {
      can: vi.fn().mockResolvedValue({ params: { filter: { $and: [{ id: { $in: [1] } }] } } }),
    };
    const database = {
      getRepository: () => ({
        findOne: vi.fn().mockResolvedValue({
          get: (attribute: string) => {
            if (attribute === 'localPath') return 'skills';
            if (attribute === 'registryExportEnabled') return true;
            return null;
          },
        }),
      }),
    } as unknown as Database;
    const service = new RegistryGitContentService(database, undefined, acl);

    await expect(service.resolveCommit(1, 'HEAD', { kind: 'user', roles: ['developer'] })).resolves.toBe(commitSha);
    expect(acl.can).toHaveBeenCalledWith({
      roles: ['developer'],
      resource: 'gitManager',
      action: 'fileContent',
    });
  });

  it('rejects a user whose Git Manager scope excludes the requested repository', async () => {
    const acl = {
      can: vi.fn().mockResolvedValue({ params: { filter: { $and: [{ id: { $in: [1] } }] } } }),
    };
    const repositoryLookup = vi.fn();
    const database = {
      getRepository: repositoryLookup,
    } as unknown as Database;
    const service = new RegistryGitContentService(database, undefined, acl);

    await expect(service.assertRepositoryAccess(2, { kind: 'user', roles: ['developer'] })).rejects.toMatchObject({
      code: 'REGISTRY_REPOSITORY_ACCESS_DENIED',
    });
    expect(repositoryLookup).not.toHaveBeenCalled();
  });

  it('allows root without evaluating repository scope', async () => {
    const acl = { can: vi.fn() };
    const database = {
      getRepository: () => ({
        findOne: vi.fn().mockResolvedValue({
          get: (attribute: string) => {
            if (attribute === 'localPath') return 'skills';
            if (attribute === 'registryExportEnabled') return true;
            return null;
          },
        }),
      }),
    } as unknown as Database;
    const service = new RegistryGitContentService(database, undefined, acl);

    await expect(service.resolveCommit(1, 'HEAD', { kind: 'user', roles: ['root'] })).resolves.toBe(commitSha);
    expect(acl.can).not.toHaveBeenCalled();
  });

  it('allows a scheduled system sync but still requires the repository export opt-in', async () => {
    const acl = { can: vi.fn() };
    const database = {
      getRepository: () => ({
        findOne: vi.fn().mockResolvedValue({
          get: (attribute: string) => {
            if (attribute === 'localPath') return 'skills';
            if (attribute === 'registryExportEnabled') return true;
            return null;
          },
        }),
      }),
    } as unknown as Database;
    const service = new RegistryGitContentService(database, undefined, acl);

    await expect(service.resolveCommit(1, 'HEAD', scheduledSyncAccess)).resolves.toBe(commitSha);
    expect(acl.can).not.toHaveBeenCalled();
  });

  it('rejects an otherwise authorized user when repository export is disabled', async () => {
    const acl = {
      can: vi.fn().mockResolvedValue({ params: { filter: { $and: [{ id: { $in: [1] } }] } } }),
    };
    const database = {
      getRepository: () => ({
        findOne: vi.fn().mockResolvedValue({
          get: (attribute: string) => (attribute === 'registryExportEnabled' ? false : 'skills'),
        }),
      }),
    } as unknown as Database;
    const service = new RegistryGitContentService(database, undefined, acl);

    await expect(service.assertRepositoryAccess(1, { kind: 'user', roles: ['developer'] })).rejects.toMatchObject({
      code: 'REGISTRY_EXPORT_NOT_GRANTED',
    });
  });

  it('allows Skill Hub reads for a scoped user even when Registry export is disabled', async () => {
    const acl = {
      can: vi.fn().mockResolvedValue({ params: { filter: { $and: [{ id: { $in: [1] } }] } } }),
    };
    const database = {
      getRepository: () => ({
        findOne: vi.fn().mockResolvedValue({
          get: (attribute: string) => {
            if (attribute === 'localPath') return 'skills';
            if (attribute === 'registryExportEnabled') return false;
            return null;
          },
        }),
      }),
    } as unknown as Database;
    const service = new SkillHubGitContentService(database, undefined, acl);

    expect(service.contractVersion).toBe(2);
    expect(service.capabilities).toContain('skill-hub-content-with-actor');
    await expect(
      service.readFile({ repositoryId: 1, commitSha, filePath: 'payload.bin' }, { kind: 'user', roles: ['developer'] }),
    ).resolves.toEqual(Buffer.from([0, 255, 128, 17]));
  });

  it('rejects a Skill Hub user outside repository scope before reading the database', async () => {
    const acl = {
      can: vi.fn().mockResolvedValue({ params: { filter: { $and: [{ id: { $in: [1] } }] } } }),
    };
    const repositoryLookup = vi.fn();
    const database = {
      getRepository: repositoryLookup,
    } as unknown as Database;
    const service = new SkillHubGitContentService(database, undefined, acl);

    await expect(service.assertRepositoryAccess(2, { kind: 'user', roles: ['developer'] })).rejects.toMatchObject({
      code: 'SKILL_HUB_REPOSITORY_ACCESS_DENIED',
    });
    expect(repositoryLookup).not.toHaveBeenCalled();
  });

  it('rejects a Skill Hub call without an actor before reading the database', async () => {
    const repositoryLookup = vi.fn();
    const database = {
      getRepository: repositoryLookup,
    } as unknown as Database;
    const service = new SkillHubGitContentService(database);

    await expect(service.assertRepositoryAccess(1)).rejects.toMatchObject({
      code: 'SKILL_HUB_REPOSITORY_ACCESS_DENIED',
    });
    expect(repositoryLookup).not.toHaveBeenCalled();
  });

  it('rejects a scheduled system actor from Skill Hub before reading the database', async () => {
    const repositoryLookup = vi.fn();
    const database = {
      getRepository: repositoryLookup,
    } as unknown as Database;
    const service = new SkillHubGitContentService(database);

    await expect(service.assertRepositoryAccess(1, scheduledSyncAccess)).rejects.toMatchObject({
      code: 'SKILL_HUB_REPOSITORY_ACCESS_DENIED',
    });
    expect(repositoryLookup).not.toHaveBeenCalled();
  });
});
