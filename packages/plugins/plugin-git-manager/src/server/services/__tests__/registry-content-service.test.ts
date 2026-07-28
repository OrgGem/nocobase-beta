import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { Database } from '@nocobase/database';

import { RegistryGitContentService } from '../registry-content-service';

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

    await expect(service.readFile({ repositoryId: 1, commitSha, filePath: 'payload.bin' })).resolves.toEqual(
      Buffer.from([0, 255, 128, 17]),
    );
    await expect(service.readFile({ repositoryId: 1, commitSha, filePath: 'missing.json' })).rejects.toMatchObject({
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

    await expect(service.resolveCommit(1, 'HEAD')).rejects.toMatchObject({
      code: 'REGISTRY_EXPORT_NOT_GRANTED',
    });
    await expect(
      service.readFile({ repositoryId: 1, commitSha, filePath: 'payload.bin' }),
    ).rejects.toMatchObject({
      code: 'REGISTRY_EXPORT_NOT_GRANTED',
    });
  });

  it('does not distinguish a missing repository from an ungranted repository', async () => {
    const database = {
      getRepository: () => ({ findOne: vi.fn().mockResolvedValue(null) }),
    } as unknown as Database;
    const service = new RegistryGitContentService(database);

    await expect(service.resolveCommit(404, 'HEAD')).rejects.toMatchObject({
      code: 'REGISTRY_EXPORT_NOT_GRANTED',
    });
  });

  it('stops buffering a Git file after the configured source-file limit', async () => {
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

    await expect(service.readFile({ repositoryId: 1, commitSha, filePath: 'payload.bin' })).rejects.toThrow(
      'Git file exceeds the registry source-file limit.',
    );
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
      service.listTree({ repositoryId: 1, commitSha, rootPath: '', recursive: true }),
    ).rejects.toThrow('Git tree contains too many entries for registry export.');
  });
});
