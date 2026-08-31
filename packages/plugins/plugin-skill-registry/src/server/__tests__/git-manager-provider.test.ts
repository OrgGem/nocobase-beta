import { GitManagerSourceProvider } from '../providers/git-manager-provider';
import { ARTIFACT_LIMITS } from '../services/artifact-builder';
import { SOURCE_INGESTION_LIMITS } from '../services/candidate-validator';

const commitA = 'a'.repeat(40);
const commitB = 'b'.repeat(40);

describe('GitManagerSourceProvider', () => {
  it('uses one pinned commit during a source sync and resolves a fresh commit after release', async () => {
    const skillMarkdown = Buffer.from('---\nname: report\n---\nBuild a report.\n');
    const code = Buffer.from('print("report")\n');
    const resolveCommit = vi.fn().mockResolvedValueOnce(commitA).mockResolvedValueOnce(commitB);
    const listTree = vi
      .fn()
      .mockImplementation(async ({ rootPath, recursive }: { rootPath: string; recursive: boolean }) => {
        if (rootPath === 'automation/skills') {
          return [{ type: 'tree', path: 'report', size: 0 }];
        }
        if (rootPath === 'automation/skills/report' && !recursive) {
          return [{ type: 'blob', path: 'SKILL.md', size: skillMarkdown.length }];
        }
        return [
          { type: 'blob', path: 'SKILL.md', size: skillMarkdown.length },
          { type: 'blob', path: 'index.py', size: code.length },
        ];
      });
    const readFile = vi.fn().mockImplementation(async ({ filePath }: { filePath: string }) => {
      if (filePath.endsWith('skills.json')) {
        throw Object.assign(new Error('skills.json is absent'), { code: 'REGISTRY_GIT_FILE_NOT_FOUND' });
      }
      if (filePath.endsWith('SKILL.md')) {
        return skillMarkdown;
      }
      return code;
    });
    const provider = new GitManagerSourceProvider({
      get: () => ({ registryContentService: { resolveCommit, listTree, readFile } }),
    });
    const source = {
      id: 'source-1',
      providerType: 'git-manager' as const,
      namespace: 'acme',
      providerConfig: { repositoryId: 9, ref: 'refs/heads/main', rootPath: 'automation' },
    };

    await provider.discover(source);
    const candidate = await provider.getCandidate(source, 'report');

    expect(candidate.source.revision).toBe(commitA);
    expect(resolveCommit).toHaveBeenCalledTimes(1);

    provider.releaseSource(source);
    const refreshedCandidate = await provider.getCandidate(source, 'report');

    expect(refreshedCandidate.source.revision).toBe(commitB);
    expect(resolveCommit).toHaveBeenCalledTimes(2);
  });

  it.each([['.kiro'], ['.kiro/skills']])(
    'uses a configured root first and falls back to its skills subfolder only when it exists (%s)',
    async (rootPath) => {
      const readFile = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('skills.json is absent'), { code: 'REGISTRY_GIT_FILE_NOT_FOUND' }));
      const listTree = vi
        .fn()
        .mockImplementation(async ({ rootPath, recursive }: { rootPath: string; recursive: boolean }) => {
          expect(recursive).toBe(false);
          if (rootPath === '.kiro') {
            return [{ type: 'tree', path: 'skills', size: 0 }];
          }
          if (rootPath === '.kiro/skills') {
            return [
              { type: 'tree', path: 'alpha', size: 0 },
              { type: 'tree', path: 'beta', size: 0 },
              { type: 'tree', path: 'not-a-skill', size: 0 },
            ];
          }
          if (rootPath === '.kiro/skills/not-a-skill') {
            return [{ type: 'blob', path: 'README.md', size: 10 }];
          }
          return [{ type: 'blob', path: 'SKILL.md', size: 10 }];
        });
      const provider = new GitManagerSourceProvider({
        get: () => ({
          registryContentService: { resolveCommit: vi.fn().mockResolvedValue(commitA), listTree, readFile },
        }),
      });

      await expect(
        provider.discover({
          id: 'source-1',
          providerType: 'git-manager',
          namespace: 'orggem',
          providerConfig: { repositoryId: 1, ref: 'main', rootPath },
        }),
      ).resolves.toEqual(['alpha', 'beta']);
      expect(listTree).not.toHaveBeenCalledWith(expect.objectContaining({ rootPath: '.kiro/skills/skills' }));
    },
  );

  it('keeps a configured root that directly contains skill folders', async () => {
    const readFile = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('skills.json is absent'), { code: 'REGISTRY_GIT_FILE_NOT_FOUND' }));
    const listTree = vi
      .fn()
      .mockImplementation(async ({ rootPath, recursive }: { rootPath: string; recursive: boolean }) => {
        expect(recursive).toBe(false);
        if (rootPath === 'agent-assets') {
          return [{ type: 'tree', path: 'reporting', size: 0 }];
        }
        if (rootPath === 'agent-assets/reporting') {
          return [{ type: 'blob', path: 'SKILL.md', size: 10 }];
        }
        throw new Error(`Unexpected root path: ${rootPath}`);
      });
    const provider = new GitManagerSourceProvider({
      get: () => ({
        registryContentService: { resolveCommit: vi.fn().mockResolvedValue(commitA), listTree, readFile },
      }),
    });

    await expect(
      provider.discover({
        id: 'source-1',
        providerType: 'git-manager',
        namespace: 'orggem',
        providerConfig: { repositoryId: 1, ref: 'main', rootPath: 'agent-assets' },
      }),
    ).resolves.toEqual(['reporting']);
    expect(listTree).not.toHaveBeenCalledWith(expect.objectContaining({ rootPath: 'agent-assets/skills' }));
  });

  it('does not append another skills directory when the configured root already ends in skills', async () => {
    const readFile = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('skills.json is absent'), { code: 'REGISTRY_GIT_FILE_NOT_FOUND' }));
    const listTree = vi.fn().mockImplementation(async ({ rootPath }: { rootPath: string }) => {
      if (rootPath === 'agent-assets/skills') {
        return [{ type: 'tree', path: 'skills', size: 0 }];
      }
      if (rootPath === 'agent-assets/skills/skills') {
        return [{ type: 'blob', path: 'SKILL.md', size: 10 }];
      }
      throw new Error(`Unexpected root path: ${rootPath}`);
    });
    const provider = new GitManagerSourceProvider({
      get: () => ({
        registryContentService: { resolveCommit: vi.fn().mockResolvedValue(commitA), listTree, readFile },
      }),
    });

    await expect(
      provider.discover({
        id: 'source-1',
        providerType: 'git-manager',
        namespace: 'orggem',
        providerConfig: { repositoryId: 1, ref: 'main', rootPath: 'agent-assets/skills' },
      }),
    ).resolves.toEqual(['skills']);
    expect(listTree).not.toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: 'agent-assets/skills/skills/skills' }),
    );
  });

  it('falls back to a nested skills directory when the configured root has more unrelated folders than the skill limit', async () => {
    const unrelatedFolders = Array.from({ length: SOURCE_INGESTION_LIMITS.maxItems + 1 }, (_, index) => ({
      type: 'tree' as const,
      path: `unrelated-${index}`,
      size: 0,
    }));
    const readFile = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('skills.json is absent'), { code: 'REGISTRY_GIT_FILE_NOT_FOUND' }));
    const listTree = vi
      .fn()
      .mockImplementation(async ({ rootPath, recursive }: { rootPath: string; recursive: boolean }) => {
        expect(recursive).toBe(false);
        if (rootPath === 'automation') {
          return [...unrelatedFolders, { type: 'tree' as const, path: 'skills', size: 0 }];
        }
        if (rootPath === 'automation/skills') {
          return [{ type: 'tree' as const, path: 'report', size: 0 }];
        }
        if (rootPath === 'automation/skills/report') {
          return [{ type: 'blob' as const, path: 'SKILL.md', size: 10 }];
        }
        if (rootPath.startsWith('automation/unrelated-')) {
          return [];
        }
        throw new Error(`Unexpected root path: ${rootPath}`);
      });
    const provider = new GitManagerSourceProvider({
      get: () => ({
        registryContentService: { resolveCommit: vi.fn().mockResolvedValue(commitA), listTree, readFile },
      }),
    });

    await expect(
      provider.discover({
        id: 'source-1',
        providerType: 'git-manager',
        namespace: 'orggem',
        providerConfig: { repositoryId: 1, ref: 'main', rootPath: 'automation' },
      }),
    ).resolves.toEqual(['report']);
    expect(listTree).toHaveBeenCalledWith(expect.objectContaining({ rootPath: 'automation/skills' }));
  });

  it('builds an instruction-only candidate from SKILL.md and includes all files in the skill folder', async () => {
    const markdown = Buffer.from(
      '---\nname: gen-doc-ppt-master\ndescription: Generate documents\n---\nFollow these instructions.\n',
    );
    const helperContent = Buffer.from('# helper utility\n');
    const listTree = vi.fn().mockImplementation(async ({ recursive, rootPath }: { recursive: boolean; rootPath: string }) => {
      // The non-recursive call fetches SKILL.md size; the recursive call collects all skill files.
      if (rootPath === '.kiro/gen-doc-ppt-master') {
        if (recursive) {
          return [
            { type: 'blob', path: 'SKILL.md', size: markdown.length },
            { type: 'blob', path: 'helper.py', size: helperContent.length },
          ];
        }
        return [{ type: 'blob', path: 'SKILL.md', size: markdown.length }];
      }
      // Discovery calls at the root level.
      return [{ type: 'tree', path: 'gen-doc-ppt-master', size: 0 }];
    });
    const readFile = vi.fn().mockImplementation(async ({ filePath }: { filePath: string }) => {
        if (filePath.endsWith('skills.json')) {
          throw Object.assign(new Error('skills.json is absent'), { code: 'REGISTRY_GIT_FILE_NOT_FOUND' });
        }
        if (filePath.endsWith('SKILL.md')) return markdown;
        if (filePath.endsWith('helper.py')) return helperContent;
        throw new Error(`Unexpected readFile: ${filePath}`);
      });
    const provider = new GitManagerSourceProvider({
      get: () => ({
        registryContentService: { resolveCommit: vi.fn().mockResolvedValue(commitA), listTree, readFile },
      }),
    });

    const candidate = await provider.getCandidate(
      {
        id: 'source-1',
        providerType: 'git-manager',
        namespace: 'orggem',
        providerConfig: { repositoryId: 1, ref: 'main', rootPath: '.kiro' },
      },
      'gen-doc-ppt-master',
    );

    // Auto-detected entrypoint from helper.py since no explicit codeFile was declared.
    expect(candidate.manifest.runtime).toEqual({ kind: 'python', entrypoint: 'helper.py' });
    expect(candidate.files.map((file) => file.path).sort()).toEqual(['SKILL.md', 'helper.py']);
    expect(listTree).toHaveBeenCalledWith(expect.objectContaining({ rootPath: '.kiro/gen-doc-ppt-master', recursive: true }));
    expect(listTree).not.toHaveBeenCalledWith(expect.objectContaining({ rootPath: '.kiro/skills/gen-doc-ppt-master' }));
  });

  it('does not treat an export denial while reading optional skills.json as a missing file', async () => {
    const resolveCommit = vi.fn().mockResolvedValue(commitA);
    const listTree = vi.fn();
    const denied = Object.assign(new Error('not granted'), { code: 'REGISTRY_EXPORT_NOT_GRANTED' });
    const readFile = vi.fn().mockRejectedValue(denied);
    const provider = new GitManagerSourceProvider({
      get: () => ({ registryContentService: { resolveCommit, listTree, readFile } }),
    });

    await expect(
      provider.discover({
        id: 'source-1',
        providerType: 'git-manager',
        namespace: 'acme',
        providerConfig: { repositoryId: 9, ref: 'refs/heads/main', registryExportEnabled: true },
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_EXPORT_NOT_GRANTED', status: 403 });
    expect(listTree).not.toHaveBeenCalled();
  });

  it('does not hide a bounded Git read failure as an absent optional manifest', async () => {
    const listTree = vi.fn();
    const limited = Object.assign(new Error('output limit'), { code: 'REGISTRY_CONTENT_LIMIT_EXCEEDED' });
    const provider = new GitManagerSourceProvider({
      get: () => ({
        registryContentService: {
          resolveCommit: vi.fn().mockResolvedValue(commitA),
          listTree,
          readFile: vi.fn().mockRejectedValue(limited),
        },
      }),
    });

    await expect(
      provider.discover({
        id: 'source-1',
        providerType: 'git-manager',
        namespace: 'acme',
        providerConfig: { repositoryId: 9, ref: 'refs/heads/main' },
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_TOO_LARGE', status: 422 });
    expect(listTree).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', Buffer.from('{"skills":')],
    ['the wrong schema', Buffer.from('{"entries":[]}')],
  ])('fails closed when a present skills.json contains %s', async (_case, skillsJson) => {
    const listTree = vi.fn();
    const provider = new GitManagerSourceProvider({
      get: () => ({
        registryContentService: {
          resolveCommit: vi.fn().mockResolvedValue(commitA),
          listTree,
          readFile: vi.fn().mockResolvedValue(skillsJson),
        },
      }),
    });

    await expect(
      provider.discover({
        id: 'source-1',
        providerType: 'git-manager',
        namespace: 'acme',
        providerConfig: { repositoryId: 9, ref: 'refs/heads/main' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MANIFEST', status: 422 });
    expect(listTree).not.toHaveBeenCalled();
  });

  it('treats an empty skills.json allowlist as authoritative', async () => {
    const listTree = vi.fn();
    const provider = new GitManagerSourceProvider({
      get: () => ({
        registryContentService: {
          resolveCommit: vi.fn().mockResolvedValue(commitA),
          listTree,
          readFile: vi.fn().mockResolvedValue(Buffer.from('{"skills":[]}')),
        },
      }),
    });

    await expect(
      provider.discover({
        id: 'source-1',
        providerType: 'git-manager',
        namespace: 'acme',
        providerConfig: { repositoryId: 9, ref: 'refs/heads/main' },
      }),
    ).resolves.toEqual([]);
    expect(listTree).not.toHaveBeenCalled();
  });

  it('does not load a source item that is absent from an authoritative skills.json', async () => {
    const listTree = vi.fn();
    const provider = new GitManagerSourceProvider({
      get: () => ({
        registryContentService: {
          resolveCommit: vi.fn().mockResolvedValue(commitA),
          listTree,
          readFile: vi.fn().mockResolvedValue(Buffer.from('{"skills":[{"folder":"approved"}]}')),
        },
      }),
    });

    await expect(
      provider.getCandidate(
        {
          id: 'source-1',
          providerType: 'git-manager',
          namespace: 'acme',
          providerConfig: { repositoryId: 9, ref: 'refs/heads/main' },
        },
        'unlisted',
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_ITEM_NOT_FOUND', status: 404 });
    expect(listTree).not.toHaveBeenCalled();
  });

  it('rejects an oversized Git tree before reading skill file contents', async () => {
    const readFile = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('skills.json is absent'), { code: 'REGISTRY_GIT_FILE_NOT_FOUND' }));
    const provider = new GitManagerSourceProvider({
      get: () => ({
        registryContentService: {
          resolveCommit: vi.fn().mockResolvedValue(commitA),
          listTree: vi
            .fn()
            .mockResolvedValue([{ type: 'blob', path: 'SKILL.md', size: ARTIFACT_LIMITS.maxExpandedBytes + 1 }]),
          readFile,
        },
      }),
    });
    const source = {
      id: 'source-1',
      providerType: 'git-manager' as const,
      namespace: 'acme',
      providerConfig: { repositoryId: 9, ref: 'refs/heads/main' },
    };

    await expect(provider.getCandidate(source, 'report')).rejects.toMatchObject({
      code: 'ARTIFACT_TOO_LARGE',
      status: 422,
    });
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('rejects bytes that do not match the pinned Git tree size', async () => {
    const provider = new GitManagerSourceProvider({
      get: () => ({
        registryContentService: {
          resolveCommit: vi.fn().mockResolvedValue(commitA),
          listTree: vi.fn().mockResolvedValue([{ type: 'blob', path: 'SKILL.md', size: 1 }]),
          readFile: vi
            .fn()
            .mockRejectedValueOnce(
              Object.assign(new Error('skills.json is absent'), { code: 'REGISTRY_GIT_FILE_NOT_FOUND' }),
            )
            .mockResolvedValueOnce(Buffer.from('more than one byte')),
        },
      }),
    });

    await expect(
      provider.getCandidate(
        {
          id: 'source-1',
          providerType: 'git-manager',
          namespace: 'acme',
          providerConfig: { repositoryId: 9, ref: 'refs/heads/main' },
        },
        'report',
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_CONTENT_CHANGED', status: 409 });
  });

  it('forwards the requesting user to Git Manager and maps repository scope denial to a stable 403', async () => {
    const access = { kind: 'user' as const, userId: 'admin-1', roles: ['registry-manager'] };
    const denied = Object.assign(new Error('repository denied'), { code: 'REGISTRY_REPOSITORY_ACCESS_DENIED' });
    const resolveCommit = vi.fn().mockRejectedValue(denied);
    const provider = new GitManagerSourceProvider({
      get: () => ({
        registryContentService: {
          contractVersion: 2,
          capabilities: ['registry-content-with-actor', 'registry-content-authorize-source'],
          resolveCommit,
          listTree: vi.fn(),
          readFile: vi.fn(),
          assertRepositoryAccess: vi.fn(),
        },
      }),
    });
    const source = {
      id: 'source-1',
      providerType: 'git-manager' as const,
      namespace: 'acme',
      providerConfig: { repositoryId: 9, ref: 'refs/heads/main' },
    };

    await expect(provider.discover(source, access)).rejects.toMatchObject({
      code: 'SOURCE_REPOSITORY_ACCESS_DENIED',
      status: 403,
    });
    expect(resolveCommit).toHaveBeenCalledWith(9, 'refs/heads/main', access);
  });

  it('requires an actor-aware Git Manager contract instead of failing with a raw method error', async () => {
    const provider = new GitManagerSourceProvider({
      get: () => ({
        registryContentService: {
          resolveCommit: vi.fn(),
          listTree: vi.fn(),
          readFile: vi.fn(),
        },
      }),
    });

    await expect(
      provider.discover(
        {
          id: 'source-1',
          providerType: 'git-manager',
          namespace: 'acme',
          providerConfig: { repositoryId: 9, ref: 'refs/heads/main' },
        },
        { kind: 'user', roles: ['registry-manager'] },
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_PROVIDER_UNAVAILABLE', status: 424 });
  });

  it('authorizes a Git source binding before it can be persisted', async () => {
    const assertRepositoryAccess = vi.fn().mockResolvedValue(undefined);
    const provider = new GitManagerSourceProvider({
      get: () => ({
        registryContentService: {
          contractVersion: 2,
          capabilities: ['registry-content-with-actor', 'registry-content-authorize-source'],
          assertRepositoryAccess,
          resolveCommit: vi.fn(),
          listTree: vi.fn(),
          readFile: vi.fn(),
        },
      }),
    });
    const access = { kind: 'user' as const, userId: 'admin-1', roles: ['registry-manager'] };

    await provider.assertAccess(
      {
        id: 'new-source',
        providerType: 'git-manager',
        namespace: 'acme',
        providerConfig: { repositoryId: 9, ref: 'refs/heads/main' },
      },
      access,
    );

    expect(assertRepositoryAccess).toHaveBeenCalledWith(9, access);
  });
});
