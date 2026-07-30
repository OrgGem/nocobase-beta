import { GitManagerSourceProvider } from '../providers/git-manager-provider';
import { ARTIFACT_LIMITS } from '../services/artifact-builder';

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

  it('generates a bounded virtual manifest from direct skill folders when skills.json is absent', async () => {
    const readFile = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('skills.json is absent'), { code: 'REGISTRY_GIT_FILE_NOT_FOUND' }));
    const listTree = vi
      .fn()
      .mockImplementation(async ({ rootPath, recursive }: { rootPath: string; recursive: boolean }) => {
        expect(recursive).toBe(false);
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
        providerConfig: { repositoryId: 1, ref: 'main', rootPath: '.kiro' },
      }),
    ).resolves.toEqual(['alpha', 'beta']);
  });

  it('builds an instruction-only candidate from SKILL.md without scanning unrelated files', async () => {
    const markdown = Buffer.from(
      '---\nname: gen-doc-ppt-master\ndescription: Generate documents\n---\nFollow these instructions.\n',
    );
    const listTree = vi.fn().mockImplementation(async ({ recursive }: { recursive: boolean }) => {
      expect(recursive).toBe(false);
      return [
        { type: 'blob', path: 'SKILL.md', size: markdown.length },
        { type: 'tree', path: 'references', size: 0 },
        { type: 'blob', path: 'large-model.bin', size: ARTIFACT_LIMITS.maxExpandedBytes + 1 },
      ];
    });
    const readFile = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('skills.json is absent'), { code: 'REGISTRY_GIT_FILE_NOT_FOUND' }))
      .mockResolvedValue(markdown);
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

    expect(candidate.manifest.runtime).toEqual({ kind: 'instruction', entrypoint: 'SKILL.md' });
    expect(candidate.files.map((file) => file.path)).toEqual(['SKILL.md']);
    expect(listTree).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledTimes(3);
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
});
