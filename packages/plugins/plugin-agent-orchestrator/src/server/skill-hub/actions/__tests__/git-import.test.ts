import type { Context } from '@nocobase/actions';

import { GIT_SKILL_MARKDOWN_LIMITS, gitListSkills, gitSyncSkills } from '../git-import';
import { createGitImportRequestMethodPolicy } from '../../middlewares/git-import-request-method-policy';

const commitSha = 'a'.repeat(40);
const actor = { kind: 'user' as const, roles: ['developer'] };

type GitEntry = { type: 'blob' | 'tree'; path: string; size: number };

type SkillDefinitionsRepository = {
  find?: ReturnType<typeof vi.fn>;
  findOne: ReturnType<typeof vi.fn>;
  create?: ReturnType<typeof vi.fn>;
};

type ContentService = {
  contractVersion: number;
  capabilities: string[];
  resolveCommit: ReturnType<typeof vi.fn>;
  listTree: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
};

type TestContext = {
  context: Context;
  getRepository: ReturnType<typeof vi.fn>;
  skillDefinitions: SkillDefinitionsRepository;
};

function gitError(code: string, message = code): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

function createContentService(input?: Partial<ContentService>): ContentService {
  return {
    contractVersion: 2,
    capabilities: ['skill-hub-content-with-actor'],
    resolveCommit: vi.fn().mockResolvedValue(commitSha),
    listTree: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({ skills: [] }))),
    ...input,
  };
}

function skillsRootEntries(rootPath: string): GitEntry[] {
  if (rootPath === 'skills') {
    return [{ type: 'tree', path: 'alpha', size: 0 }];
  }
  if (rootPath === 'skills/alpha') {
    return [{ type: 'blob', path: 'SKILL.md', size: 16 }];
  }
  return [];
}

function createContext(input: {
  service?: ContentService;
  params: Record<string, unknown>;
  skillDefinitions?: SkillDefinitionsRepository;
}): TestContext {
  const skillDefinitions =
    input.skillDefinitions ||
    ({
      find: vi.fn().mockResolvedValue([]),
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(undefined),
    } satisfies SkillDefinitionsRepository);
  const getRepository = vi.fn((name: string) => {
    if (name === 'gitRepositories') {
      throw new Error('Git repositories must only be read through Git Manager.');
    }
    if (name === 'skillDefinitions') {
      return skillDefinitions;
    }
    throw new Error(`Unexpected repository: ${name}`);
  });
  const context = {
    action: { params: input.params },
    state: { currentRoles: actor.roles },
    app: {
      pm: {
        get: vi.fn().mockReturnValue(input.service ? { skillHubContentService: input.service } : undefined),
      },
    },
    db: { getRepository },
    throw(status: number, message: string): never {
      throw httpError(status, message);
    },
  } as unknown as Context;
  return { context, getRepository, skillDefinitions };
}

function createMethodContext(actionName: 'gitListSkills' | 'gitSyncSkills', method: string) {
  const headers = new Map<string, string>();
  return {
    headers,
    method,
    action: { resourceName: 'skillHub', actionName, params: {} },
    set(name: string, value: string) {
      headers.set(name, value);
    },
    throw(status: number, message: string): never {
      throw httpError(status, message);
    },
  } as unknown as Context;
}

describe('Skill Hub Git import', () => {
  it('allows only GET/HEAD for listing and POST for syncing', async () => {
    const middleware = createGitImportRequestMethodPolicy();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(createMethodContext('gitListSkills', 'GET'), next);
    await middleware(createMethodContext('gitListSkills', 'HEAD'), next);
    await middleware(createMethodContext('gitSyncSkills', 'POST'), next);
    expect(next).toHaveBeenCalledTimes(3);

    const rejectedList = createMethodContext('gitListSkills', 'POST');
    await expect(middleware(rejectedList, next)).rejects.toMatchObject({ status: 405 });
    expect((rejectedList as unknown as { headers: Map<string, string> }).headers.get('Allow')).toBe('GET, HEAD');

    const rejectedSync = createMethodContext('gitSyncSkills', 'GET');
    await expect(middleware(rejectedSync, next)).rejects.toMatchObject({ status: 405 });
    expect((rejectedSync as unknown as { headers: Map<string, string> }).headers.get('Allow')).toBe('POST');
  });

  it('lists skills through the actor-aware Git Manager service without reading gitRepositories', async () => {
    const service = createContentService({
      listTree: vi.fn().mockImplementation(async ({ rootPath }: { rootPath: string }) => skillsRootEntries(rootPath)),
      readFile: vi
        .fn()
        .mockResolvedValue(
          Buffer.from(JSON.stringify({ skills: [{ folder: 'alpha', name: 'alpha', title: 'Alpha' }] })),
        ),
    });
    const { context, getRepository } = createContext({
      service,
      params: { repositoryId: 42, rootFolder: 'skills' },
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await gitListSkills(context, next);

    expect(service.resolveCommit).toHaveBeenCalledWith(42, 'HEAD', actor);
    expect(service.readFile).toHaveBeenCalledWith(
      { repositoryId: 42, commitSha, filePath: 'skills/skills.json' },
      actor,
    );
    expect(getRepository).toHaveBeenCalledWith('skillDefinitions');
    expect(getRepository).not.toHaveBeenCalledWith('gitRepositories');
    expect((context as unknown as { body: { data: Array<{ name: string }> } }).body.data).toEqual([
      expect.objectContaining({ name: 'alpha', existsInDb: false }),
    ]);
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects a role outside the Git repository scope before any database read', async () => {
    const service = createContentService({
      resolveCommit: vi.fn().mockRejectedValue(gitError('SKILL_HUB_REPOSITORY_ACCESS_DENIED', 'Scope denied')),
    });
    const { context, getRepository } = createContext({
      service,
      params: { repositoryId: 42, rootFolder: 'skills' },
    });

    await expect(gitListSkills(context, vi.fn())).rejects.toMatchObject({ status: 403, message: 'Scope denied' });
    expect(getRepository).not.toHaveBeenCalled();
    expect(service.listTree).not.toHaveBeenCalled();
    expect(service.readFile).not.toHaveBeenCalled();
  });

  it('localizes Git Manager bridge setup errors', async () => {
    const { context } = createContext({ params: { repositoryId: 42, rootFolder: 'skills' } });
    const translate = vi.fn((key: string) => `localized:${key}`);
    (context as unknown as { t: typeof translate }).t = translate;

    await expect(gitListSkills(context, vi.fn())).rejects.toMatchObject({
      status: 424,
      message: 'localized:Git Manager is not enabled for Skill Hub imports.',
    });
    expect(translate).toHaveBeenCalledWith('Git Manager is not enabled for Skill Hub imports.', {
      ns: 'plugin-agent-orchestrator',
    });
  });

  it('uses a virtual manifest without writing a Git checkout when skills.json is missing', async () => {
    const service = createContentService({
      listTree: vi.fn().mockImplementation(async ({ rootPath }: { rootPath: string }) => skillsRootEntries(rootPath)),
      readFile: vi.fn().mockRejectedValue(gitError('REGISTRY_GIT_FILE_NOT_FOUND')),
    });
    const { context } = createContext({
      service,
      params: { repositoryId: 42, rootFolder: 'skills' },
    });

    await gitListSkills(context, vi.fn());

    const body = context as unknown as {
      body: { data: Array<{ name: string }>; config: { initializedSkillsJson: boolean } };
    };
    expect(body.body.data).toEqual([expect.objectContaining({ name: 'alpha' })]);
    expect(body.body.config.initializedSkillsJson).toBe(false);
  });

  it('uses the same actor and pinned commit when syncing a selected skill', async () => {
    const created: Array<Record<string, unknown>> = [];
    const service = createContentService({
      listTree: vi.fn().mockImplementation(async ({ rootPath }: { rootPath: string }) => skillsRootEntries(rootPath)),
      readFile: vi
        .fn()
        .mockResolvedValue(
          Buffer.from(JSON.stringify({ skills: [{ name: 'alpha', storageType: 'plugin', pluginSource: 'alpha' }] })),
        ),
    });
    const skillDefinitions: SkillDefinitionsRepository = {
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ values }: { values: Record<string, unknown> }) => {
        created.push(values);
      }),
    };
    const { context, getRepository } = createContext({
      service,
      skillDefinitions,
      params: { repositoryId: 42, rootFolder: 'skills', values: { skills: ['alpha'] } },
    });

    await gitSyncSkills(context, vi.fn());

    expect(getRepository).not.toHaveBeenCalledWith('gitRepositories');
    expect(service.resolveCommit).toHaveBeenCalledWith(42, 'HEAD', actor);
    expect(service.readFile).toHaveBeenCalledWith(
      { repositoryId: 42, commitSha, filePath: 'skills/skills.json' },
      actor,
    );
    expect(created).toEqual([
      expect.objectContaining({ name: 'alpha', storageUrl: `git://42/skills@${commitSha}#alpha` }),
    ]);
  });

  it('rejects a selected key absent from an explicit skills.json manifest before writing a skill', async () => {
    const service = createContentService({
      listTree: vi.fn().mockImplementation(async ({ rootPath }: { rootPath: string }) => skillsRootEntries(rootPath)),
      readFile: vi
        .fn()
        .mockResolvedValue(Buffer.from(JSON.stringify({ skills: [{ folder: 'alpha', name: 'alpha' }] }))),
    });
    const skillDefinitions: SkillDefinitionsRepository = {
      findOne: vi.fn(),
      create: vi.fn(),
    };
    const { context } = createContext({
      service,
      skillDefinitions,
      params: { repositoryId: 42, rootFolder: 'skills', values: { skills: ['unlisted'] } },
    });

    await expect(gitSyncSkills(context, vi.fn())).rejects.toMatchObject({
      status: 400,
      message: 'Selected skills are not listed in the explicit skills.json manifest: unlisted',
    });
    expect(skillDefinitions.findOne).not.toHaveBeenCalled();
    expect(skillDefinitions.create).not.toHaveBeenCalled();
  });

  it('allows a selected key from a virtual manifest when skills.json is absent', async () => {
    const service = createContentService({
      listTree: vi.fn().mockImplementation(async ({ rootPath }: { rootPath: string }) => skillsRootEntries(rootPath)),
      readFile: vi.fn().mockRejectedValue(gitError('REGISTRY_GIT_FILE_NOT_FOUND')),
    });
    const skillDefinitions: SkillDefinitionsRepository = {
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    };
    const { context } = createContext({
      service,
      skillDefinitions,
      params: { repositoryId: 42, rootFolder: 'skills', values: { skills: ['alpha'] } },
    });

    await gitSyncSkills(context, vi.fn());

    expect(skillDefinitions.create).toHaveBeenCalledOnce();
  });

  it('rejects too many supplemental Markdown files before reading any of them', async () => {
    const supplementalFiles: GitEntry[] = Array.from(
      { length: GIT_SKILL_MARKDOWN_LIMITS.maxFiles + 1 },
      (_, index) => ({
        type: 'blob',
        path: `docs/${index}.md`,
        size: 1,
      }),
    );
    const service = createContentService({
      listTree: vi
        .fn()
        .mockImplementation(async ({ rootPath, recursive }: { rootPath: string; recursive: boolean }) => {
          if (rootPath === 'skills') return [{ type: 'tree', path: 'alpha', size: 0 }];
          if (rootPath === 'skills/alpha' && recursive) return supplementalFiles;
          if (rootPath === 'skills/alpha') return [{ type: 'blob', path: 'SKILL.md', size: 16 }];
          return [];
        }),
      readFile: vi.fn().mockImplementation(async ({ filePath }: { filePath: string }) => {
        if (filePath === 'skills/skills.json') {
          return Buffer.from(JSON.stringify({ skills: [{ folder: 'alpha', name: 'alpha' }] }));
        }
        if (filePath === 'skills/alpha/SKILL.md') {
          return Buffer.from('# Alpha');
        }
        throw new Error(`Unexpected file read: ${filePath}`);
      }),
    });
    const skillDefinitions: SkillDefinitionsRepository = {
      findOne: vi.fn(),
      create: vi.fn(),
    };
    const { context } = createContext({
      service,
      skillDefinitions,
      params: { repositoryId: 42, rootFolder: 'skills', values: { skills: ['alpha'] } },
    });

    await expect(gitSyncSkills(context, vi.fn())).rejects.toMatchObject({ status: 422 });
    expect(service.readFile).not.toHaveBeenCalledWith(
      expect.objectContaining({ filePath: 'skills/alpha/docs/0.md' }),
      actor,
    );
    expect(skillDefinitions.create).not.toHaveBeenCalled();
  });

  it('rejects supplemental Markdown whose declared aggregate size exceeds the import limit before reading it', async () => {
    const service = createContentService({
      listTree: vi
        .fn()
        .mockImplementation(async ({ rootPath, recursive }: { rootPath: string; recursive: boolean }) => {
          if (rootPath === 'skills') return [{ type: 'tree', path: 'alpha', size: 0 }];
          if (rootPath === 'skills/alpha' && recursive) {
            return [{ type: 'blob', path: 'GUIDE.md', size: GIT_SKILL_MARKDOWN_LIMITS.maxBytes }];
          }
          if (rootPath === 'skills/alpha') return [{ type: 'blob', path: 'SKILL.md', size: 16 }];
          return [];
        }),
      readFile: vi.fn().mockImplementation(async ({ filePath }: { filePath: string }) => {
        if (filePath === 'skills/skills.json') {
          return Buffer.from(JSON.stringify({ skills: [{ folder: 'alpha', name: 'alpha' }] }));
        }
        if (filePath === 'skills/alpha/SKILL.md') {
          return Buffer.from('# Alpha');
        }
        throw new Error(`Unexpected file read: ${filePath}`);
      }),
    });
    const skillDefinitions: SkillDefinitionsRepository = {
      findOne: vi.fn(),
      create: vi.fn(),
    };
    const { context } = createContext({
      service,
      skillDefinitions,
      params: { repositoryId: 42, rootFolder: 'skills', values: { skills: ['alpha'] } },
    });

    await expect(gitSyncSkills(context, vi.fn())).rejects.toMatchObject({ status: 422 });
    expect(service.readFile).not.toHaveBeenCalledWith(
      expect.objectContaining({ filePath: 'skills/alpha/GUIDE.md' }),
      actor,
    );
    expect(skillDefinitions.create).not.toHaveBeenCalled();
  });

  it('caps each supplemental Markdown read by the remaining aggregate budget', async () => {
    const service = createContentService({
      listTree: vi
        .fn()
        .mockImplementation(async ({ rootPath, recursive }: { rootPath: string; recursive: boolean }) => {
          if (rootPath === 'skills') return [{ type: 'tree', path: 'alpha', size: 0 }];
          if (rootPath === 'skills/alpha' && recursive) return [{ type: 'blob', path: 'GUIDE.md', size: 1 }];
          if (rootPath === 'skills/alpha') return [{ type: 'blob', path: 'SKILL.md', size: 16 }];
          return [];
        }),
      readFile: vi.fn().mockImplementation(async ({ filePath }: { filePath: string }) => {
        if (filePath === 'skills/skills.json') {
          return Buffer.from(JSON.stringify({ skills: [{ folder: 'alpha', name: 'alpha' }] }));
        }
        if (filePath === 'skills/alpha/SKILL.md') {
          return Buffer.from('# Alpha');
        }
        if (filePath === 'skills/alpha/GUIDE.md') {
          return Buffer.alloc(GIT_SKILL_MARKDOWN_LIMITS.maxBytes, 'a');
        }
        throw new Error(`Unexpected file read: ${filePath}`);
      }),
    });
    const skillDefinitions: SkillDefinitionsRepository = {
      findOne: vi.fn(),
      create: vi.fn(),
    };
    const { context } = createContext({
      service,
      skillDefinitions,
      params: { repositoryId: 42, rootFolder: 'skills', values: { skills: ['alpha'] } },
    });

    await expect(gitSyncSkills(context, vi.fn())).rejects.toMatchObject({ status: 422 });
    expect(service.readFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: 'skills/alpha/GUIDE.md',
        maxBytes: expect.any(Number),
      }),
      actor,
    );
    expect(skillDefinitions.create).not.toHaveBeenCalled();
  });

  it('does not convert an access denial during sync into a per-skill error', async () => {
    const service = createContentService({
      listTree: vi.fn().mockImplementation(async ({ rootPath }: { rootPath: string }) => skillsRootEntries(rootPath)),
      readFile: vi.fn().mockImplementation(async ({ filePath }: { filePath: string }) => {
        if (filePath === 'skills/skills.json') {
          return Buffer.from(JSON.stringify({ skills: [{ folder: 'alpha', name: 'alpha' }] }));
        }
        throw gitError('SKILL_HUB_REPOSITORY_ACCESS_DENIED', 'Scope was revoked');
      }),
    });
    const skillDefinitions: SkillDefinitionsRepository = {
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    };
    const { context } = createContext({
      service,
      skillDefinitions,
      params: { repositoryId: 42, rootFolder: 'skills', values: { skills: ['alpha'] } },
    });

    await expect(gitSyncSkills(context, vi.fn())).rejects.toMatchObject({ status: 403, message: 'Scope was revoked' });
    expect(skillDefinitions.create).not.toHaveBeenCalled();
  });

  it('requires the Skill Hub actor-aware Git Manager contract', async () => {
    const service = createContentService({
      contractVersion: 1,
      capabilities: ['registry-content-with-actor'],
    });
    const { context, getRepository } = createContext({
      service,
      params: { repositoryId: 42, rootFolder: 'skills' },
    });

    await expect(gitListSkills(context, vi.fn())).rejects.toMatchObject({ status: 424 });
    expect(getRepository).not.toHaveBeenCalled();
    expect(service.resolveCommit).not.toHaveBeenCalled();
  });

  it('uses the configured skills root before falling back to a nested skills folder', async () => {
    const service = createContentService({
      listTree: vi.fn().mockImplementation(async ({ rootPath }: { rootPath: string }) => {
        if (rootPath === 'agent-assets/skills') {
          return [{ type: 'tree', path: 'alpha', size: 0 }];
        }
        if (rootPath === 'agent-assets/skills/alpha') {
          return [{ type: 'blob', path: 'SKILL.md', size: 16 }];
        }
        if (rootPath === 'agent-assets/skills/skills') {
          throw new Error('must not fall back to skills/skills');
        }
        return [];
      }),
      readFile: vi.fn().mockRejectedValue(gitError('REGISTRY_GIT_FILE_NOT_FOUND')),
    });
    const { context } = createContext({
      service,
      params: { repositoryId: 42, rootFolder: 'agent-assets/skills' },
    });

    await gitListSkills(context, vi.fn());

    expect(service.listTree).not.toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: 'agent-assets/skills/skills' }),
      actor,
    );
  });

  it('falls back to a nested skills folder only when the configured root has no direct skill', async () => {
    const created: Array<Record<string, unknown>> = [];
    const service = createContentService({
      listTree: vi.fn().mockImplementation(async ({ rootPath }: { rootPath: string }) => {
        if (rootPath === 'agent-assets') {
          return [{ type: 'tree', path: 'skills', size: 0 }];
        }
        if (rootPath === 'agent-assets/skills') {
          return [{ type: 'tree', path: 'alpha', size: 0 }];
        }
        if (rootPath === 'agent-assets/skills/alpha') {
          return [{ type: 'blob', path: 'SKILL.md', size: 16 }];
        }
        return [];
      }),
      readFile: vi.fn().mockImplementation(async ({ filePath }: { filePath: string }) => {
        if (filePath === 'agent-assets/skills/skills.json') {
          return Buffer.from(JSON.stringify({ skills: [{ folder: 'alpha', name: 'alpha' }] }));
        }
        if (filePath === 'agent-assets/skills/alpha/SKILL.md') {
          return Buffer.from('# Alpha');
        }
        throw gitError('REGISTRY_GIT_FILE_NOT_FOUND');
      }),
    });
    const skillDefinitions: SkillDefinitionsRepository = {
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ values }: { values: Record<string, unknown> }) => {
        created.push(values);
      }),
    };
    const { context } = createContext({
      service,
      skillDefinitions,
      params: { repositoryId: 42, rootFolder: 'agent-assets', values: { skills: ['alpha'] } },
    });

    await gitSyncSkills(context, vi.fn());

    expect(service.readFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: 'agent-assets/skills/alpha/SKILL.md' }),
      actor,
    );
    expect(created).toEqual([
      expect.objectContaining({ name: 'alpha', storageUrl: `git://42/agent-assets/skills/alpha@${commitSha}` }),
    ]);
  });

  it('keeps a direct child folder named skills when the configured root already ends in skills', async () => {
    const service = createContentService({
      listTree: vi.fn().mockImplementation(async ({ rootPath }: { rootPath: string }) => {
        if (rootPath === 'agent-assets/skills') {
          return [{ type: 'tree', path: 'skills', size: 0 }];
        }
        if (rootPath === 'agent-assets/skills/skills') {
          return [{ type: 'blob', path: 'SKILL.md', size: 16 }];
        }
        return [];
      }),
      readFile: vi.fn().mockRejectedValue(gitError('REGISTRY_GIT_FILE_NOT_FOUND')),
    });
    const { context } = createContext({
      service,
      params: { repositoryId: 42, rootFolder: 'agent-assets/skills' },
    });

    await gitListSkills(context, vi.fn());

    expect((context as unknown as { body: { data: Array<{ name: string }> } }).body.data).toEqual([
      expect.objectContaining({ name: 'skills' }),
    ]);
  });
});
