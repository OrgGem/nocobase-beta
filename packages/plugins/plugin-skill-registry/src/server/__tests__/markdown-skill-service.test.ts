import { MarkdownSkillService } from '../services/markdown-skill-service';
import type { RegistryModel } from '../services/model-values';
import type { RegistryDatabase, RegistryRepository } from '../services/repository-types';
import { parseSkillMarkdownFrontmatter, splitSkillMarkdown } from '../services/skill-markdown-meta';

function model(values: Record<string, unknown>): RegistryModel {
  return { get: (attribute: string) => values[attribute] };
}

function repository(overrides: Partial<RegistryRepository> = {}): RegistryRepository {
  return {
    find: vi.fn().mockResolvedValue([]),
    findOne: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(model({ id: 'created' })),
    update: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createService(repositories: Record<string, RegistryRepository>) {
  const database: RegistryDatabase = {
    getRepository(name: string): RegistryRepository {
      return repositories[name];
    },
  };
  return new MarkdownSkillService(database, {} as never, {} as never);
}

describe('skill markdown frontmatter', () => {
  it('parses declared metadata from the skill file', () => {
    const content =
      '---\nname: report\ndescription: "Builds reports"\nversion: 1.2.0\nverbose: true\n---\nBody text.\n';
    expect(parseSkillMarkdownFrontmatter(content)).toEqual({
      name: 'report',
      description: 'Builds reports',
      version: '1.2.0',
      verbose: true,
    });
  });

  it('returns an empty object when the skill file has no frontmatter', () => {
    expect(parseSkillMarkdownFrontmatter('# Title\nBody')).toEqual({});
  });

  it('splits the frontmatter from the markdown body', () => {
    const content = '---\nversion: 2.0.0\n---\nBody text.\n';
    expect(splitSkillMarkdown(content)).toEqual({
      frontmatter: { version: '2.0.0' },
      body: 'Body text.\n',
    });
  });

  it('keeps content without frontmatter entirely in the body', () => {
    expect(splitSkillMarkdown('Body only')).toEqual({ frontmatter: {}, body: 'Body only' });
  });
});

describe('MarkdownSkillService.getSkillDetail', () => {
  const content = '---\nversion: 1.1.0\ndescription: Builds reports from data.\n---\nFollow these steps.\n';

  it('returns skill.md metadata and the published version history', async () => {
    const skill = model({
      id: 'skill-1',
      ownerId: 'user-1',
      namespace: 'acme',
      slug: 'report',
      displayName: 'Report',
      description: '',
      content,
      tags: [],
      visibility: 'shared',
      status: 'published',
      packageId: 'package-1',
    });
    const markdownSkills = repository({ findOne: vi.fn().mockResolvedValue(skill) });
    const versionFind = vi.fn().mockResolvedValue([
      model({
        id: 'version-2',
        version: '1.1.0',
        channel: 'stable',
        status: 'published',
        changelog: 'New',
        publishedAt: '2026-08-02T00:00:00.000Z',
      }),
      model({
        id: 'version-1',
        version: '1.0.0',
        channel: 'stable',
        status: 'yanked',
        changelog: '',
        publishedAt: '2026-08-01T00:00:00.000Z',
      }),
    ]);
    const versions = repository({ find: versionFind });
    const service = createService({ skillRegistryMarkdownSkills: markdownSkills, skillRegistryVersions: versions });

    const detail = await service.getSkillDetail('skill-1', 'user-1');

    expect(detail.markdown.frontmatter).toEqual({ version: '1.1.0', description: 'Builds reports from data.' });
    expect(detail.markdown.body).toBe('Follow these steps.\n');
    expect(detail.versions.map((version) => version.version)).toEqual(['1.1.0', '1.0.0']);
    expect(detail.versions[1].changelog).toBeNull();
    expect(versionFind).toHaveBeenCalledWith({ filter: { packageId: 'package-1' }, sort: ['-publishedAt', '-id'] });
  });

  it('returns no versions before the skill is published', async () => {
    const skill = model({ id: 'skill-1', ownerId: 'user-1', content: 'No frontmatter.', packageId: null });
    const markdownSkills = repository({ findOne: vi.fn().mockResolvedValue(skill) });
    const versions = repository();
    const service = createService({ skillRegistryMarkdownSkills: markdownSkills, skillRegistryVersions: versions });

    const detail = await service.getSkillDetail('skill-1', 'user-1');

    expect(detail.versions).toEqual([]);
    expect(detail.markdown.body).toBe('No frontmatter.');
    expect(versions.find).not.toHaveBeenCalled();
  });

  it('denies access to users who do not own the skill', async () => {
    const skill = model({ id: 'skill-1', ownerId: 'user-1', content: 'Body' });
    const markdownSkills = repository({ findOne: vi.fn().mockResolvedValue(skill) });
    const service = createService({ skillRegistryMarkdownSkills: markdownSkills });

    await expect(service.getSkillDetail('skill-1', 'user-2')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
  });
});

describe('MarkdownSkillService access control', () => {
  function sharedSkill(overrides: Record<string, unknown> = {}): RegistryModel {
    return model({
      id: 'skill-1',
      ownerId: 'user-1',
      content: 'Body',
      visibility: 'shared',
      packageId: 'package-1',
      ...overrides,
    });
  }

  function accessService(skill: RegistryModel, shareRecord: RegistryModel | null = null) {
    const markdownSkills = repository({ findOne: vi.fn().mockResolvedValue(skill) });
    const shares = repository({ findOne: vi.fn().mockResolvedValue(shareRecord) });
    const versions = repository();
    return {
      service: createService({
        skillRegistryMarkdownSkills: markdownSkills,
        skillRegistryPackageShares: shares,
        skillRegistryVersions: versions,
      }),
      shares,
    };
  }

  it('allows the owner to read the skill', async () => {
    const { service } = accessService(sharedSkill());

    const skill = await service.getSkill('skill-1', 'user-1');

    expect(skill.get('id')).toBe('skill-1');
  });

  it('allows a shared user with a package share record', async () => {
    const { service, shares } = accessService(sharedSkill(), model({ id: 'share-1' }));

    const skill = await service.getSkill('skill-1', 'user-2');

    expect(skill.get('id')).toBe('skill-1');
    expect(shares.findOne).toHaveBeenCalledWith({ filter: { packageId: 'package-1', userId: 'user-2' } });
  });

  it('denies a shared user without a package share record', async () => {
    const { service } = accessService(sharedSkill(), null);

    await expect(service.getSkill('skill-1', 'user-2')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
  });

  it('denies access to private skills even when a share record exists', async () => {
    const { service } = accessService(sharedSkill({ visibility: 'private' }), model({ id: 'share-1' }));

    await expect(service.getSkill('skill-1', 'user-2')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
  });

  it('denies access to unpublished shared skills without a package binding', async () => {
    const { service } = accessService(sharedSkill({ packageId: null }), model({ id: 'share-1' }));

    await expect(service.getSkill('skill-1', 'user-2')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
  });

  it('skips the access check when no user id is provided', async () => {
    const { service, shares } = accessService(sharedSkill());

    const skill = await service.getSkill('skill-1');

    expect(skill.get('id')).toBe('skill-1');
    expect(shares.findOne).not.toHaveBeenCalled();
  });

  it('returns skill detail to a shared user', async () => {
    const { service } = accessService(sharedSkill(), model({ id: 'share-1' }));

    const detail = await service.getSkillDetail('skill-1', 'user-2');

    expect(detail.skill.get('id')).toBe('skill-1');
    expect(detail.markdown.body).toBe('Body');
    expect(detail.versions).toEqual([]);
  });
});
