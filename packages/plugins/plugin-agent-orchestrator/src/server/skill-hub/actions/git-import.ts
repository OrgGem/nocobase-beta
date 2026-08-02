import type { Context } from '@nocobase/actions';

import { stringifyJsonText, parseJsonLike, parseSkillMarkdown } from '../utils/json-fields';
import { assertSkillToolNameAvailable, buildSkillToolName } from '../../utils/skill-tool-name';

type SkillManifestEntry = Record<string, unknown> & {
  folder?: string;
  name?: string;
  title?: string;
  description?: string;
  language?: string;
  storageType?: string;
  pluginSource?: string;
  codeTemplate?: string;
  codeFile?: string;
  timeoutSeconds?: unknown;
  maxOutputSizeMb?: unknown;
  toolScope?: string;
  enabled?: unknown;
  autoCall?: unknown;
  packages?: unknown;
  inputSchema?: unknown;
  interactionSchema?: unknown;
};

type SkillDefinitionValues = Record<string, unknown> & {
  name: string;
  toolName?: string;
  title: string;
  description: string;
  language: string;
  storageType: string;
  storageUrl: string;
  timeoutSeconds: number;
  maxOutputSizeMb: number;
  toolScope: string;
  enabled: boolean;
  autoCall: boolean;
  packages: string;
};

type SkillManifest = {
  name?: string;
  description?: string;
  skills?: SkillManifestEntry[];
  initializedAt?: string;
};

type GitManagerAccessContext = {
  kind: 'user';
  roles: string[];
};

type GitTreeEntry = {
  type: 'blob' | 'tree';
  path: string;
  size: number;
};

interface GitManagerContentService {
  contractVersion?: number;
  capabilities?: readonly string[];
  resolveCommit(repositoryId: string | number, ref: string, access: GitManagerAccessContext): Promise<string>;
  listTree(
    input: {
      repositoryId: string | number;
      commitSha: string;
      rootPath: string;
      recursive: boolean;
    },
    access: GitManagerAccessContext,
  ): Promise<GitTreeEntry[]>;
  readFile(
    input: {
      repositoryId: string | number;
      commitSha: string;
      filePath: string;
      maxBytes?: number;
    },
    access: GitManagerAccessContext,
  ): Promise<Buffer>;
}

type GitManagerPlugin = {
  skillHubContentService?: unknown;
};

type GitManagerPluginManager = {
  get(name: string): unknown;
};

type GitImportErrorCode =
  | 'GIT_MANAGER_CONTENT_UNAVAILABLE'
  | 'SKILL_HUB_REPOSITORY_ACCESS_DENIED'
  | 'SKILL_HUB_SKILL_NOT_LISTED'
  | 'REGISTRY_CONTENT_LIMIT_EXCEEDED'
  | 'REGISTRY_GIT_FILE_NOT_FOUND';

type GitImportTranslation = {
  key: string;
  values?: Record<string, string | number>;
};

class GitImportError extends Error {
  constructor(
    readonly code: GitImportErrorCode,
    readonly status: number,
    message: string,
    readonly translation?: GitImportTranslation,
  ) {
    super(message);
    this.name = 'GitImportError';
  }
}

const GIT_MANAGER_CONTENT_CAPABILITY = 'skill-hub-content-with-actor';
const GIT_MANAGER_CONTENT_CONTRACT_VERSION = 2;
const MISSING_GIT_FILE_CODE = 'REGISTRY_GIT_FILE_NOT_FOUND';
const ACCESS_DENIED_CODE = 'SKILL_HUB_REPOSITORY_ACCESS_DENIED';
const CONTENT_LIMIT_CODE = 'REGISTRY_CONTENT_LIMIT_EXCEEDED';
const GIT_IMPORT_NAMESPACE = 'plugin-agent-orchestrator';

const CODE_FILES = [
  ['index.py', 'python'],
  ['index.js', 'node'],
  ['main.py', 'python'],
] as const;

export const GIT_SKILL_MARKDOWN_LIMITS = Object.freeze({
  maxFiles: 64,
  maxBytes: 2 * 1024 * 1024,
});

/**
 * Git integration actions for skill-hub.
 *
 * All repository reads go through Git Manager's actor-aware content service.
 * This keeps the repository-level scope used by Git Manager HTTP actions in
 * force for Skill Hub imports; Skill Hub must never read a Git Manager clone
 * directly from disk.
 *
 * Supported manifest shape:
 * {
 *   "skills": [
 *     { "folder": "my-skill", "name": "my-skill", "language": "python" },
 *     { "name": "pptx-advanced-export", "storageType": "plugin", "pluginSource": "pptx-advanced-export" }
 *   ]
 * }
 */
export async function gitListSkills(ctx: Context, next: () => Promise<void>) {
  const { repositoryId, ref = 'HEAD', prefix = '' } = ctx.action.params;
  const rootFolder = normalizeRootFolder(ctx.action.params.rootFolder);

  if (!repositoryId) {
    ctx.throw(400, translateGitImportMessage(ctx, 'repositoryId and rootFolder are required'));
  }

  try {
    const service = getGitManagerContentService(ctx);
    const access = accessFromContext(ctx);
    const commitSha = await service.resolveCommit(repositoryId, ref, access);
    const configPath = joinGitPath(rootFolder, 'skills.json');
    const skillsRoot = await resolveSkillsRoot(service, repositoryId, commitSha, access, rootFolder);
    const loaded = await loadSkillsManifest(service, repositoryId, commitSha, access, configPath);
    const config = loaded.exists
      ? loaded.config
      : createSkillsManifest(
          rootFolder,
          await discoverSkills(service, repositoryId, commitSha, access, rootFolder, skillsRoot),
        );

    const manifestSkills = Array.isArray(config.skills) ? config.skills.filter((skill) => getSkillKey(skill)) : [];
    const enriched = manifestSkills.map((skill) => enrichListedSkill(skill, prefix));

    const existingSkills = enriched.length
      ? await ctx.db.getRepository('skillDefinitions').find({
          filter: { name: { $in: enriched.map((skill) => skill.name) } },
          fields: ['name'],
        })
      : [];
    const existingNames = new Set(
      existingSkills.map((skill: { get(attribute: string): unknown }) => skill.get('name')),
    );

    ctx.body = {
      data: enriched.map((skill) => ({
        ...skill,
        existsInDb: existingNames.has(skill.name),
      })),
      config: {
        name: config.name || rootFolder || 'skills',
        description: config.description || '',
        rootFolder,
        path: configPath,
        // An absent manifest is intentionally virtual. Writing a new file to
        // Git Manager's checkout would reintroduce a cross-plugin disk bypass.
        initializedSkillsJson: false,
      },
    };
    await next();
  } catch (error) {
    throwGitImportError(ctx, error);
  }
}

/**
 * Sync selected skills from git into skillDefinitions.
 *
 * Code is optional. Regular git skills may provide code via codeTemplate,
 * codeFile, or conventional files under skills/<folder>. Plugin skills only
 * need storageType=plugin and pluginSource.
 */
export async function gitSyncSkills(ctx: Context, next: () => Promise<void>) {
  const { repositoryId, ref = 'HEAD' } = ctx.action.params;
  const rootFolder = normalizeRootFolder(ctx.action.params.rootFolder);
  const { skills: selectedKeys, overwrite = false, prefix = '' } = ctx.action.params.values || ctx.action.params;

  if (!repositoryId || !Array.isArray(selectedKeys) || selectedKeys.length === 0) {
    ctx.throw(400, translateGitImportMessage(ctx, 'repositoryId, rootFolder and skills[] are required'));
  }
  const selectedSkillKeys = selectedKeys.filter(
    (key): key is string => typeof key === 'string' && key.trim().length > 0,
  );
  if (selectedSkillKeys.length !== selectedKeys.length) {
    ctx.throw(400, translateGitImportMessage(ctx, 'skills[] must contain non-empty string keys'));
  }

  try {
    const service = getGitManagerContentService(ctx);
    const access = accessFromContext(ctx);
    const commitSha = await service.resolveCommit(repositoryId, ref, access);
    const configPath = joinGitPath(rootFolder, 'skills.json');
    const skillsRoot = await resolveSkillsRoot(service, repositoryId, commitSha, access, rootFolder);
    const loaded = await loadSkillsManifest(service, repositoryId, commitSha, access, configPath);
    const config = loaded.exists
      ? loaded.config
      : createSkillsManifest(
          rootFolder,
          await discoverSkills(service, repositoryId, commitSha, access, rootFolder, skillsRoot),
        );

    const manifest = new Map<string, SkillManifestEntry>();
    for (const entry of config.skills || []) {
      const key = getSkillKey(entry);
      if (key) {
        manifest.set(key, entry);
      }
    }
    if (loaded.exists) {
      const unlistedKeys = selectedSkillKeys.filter((key) => !manifest.has(key));
      if (unlistedKeys.length > 0) {
        const skills = unlistedKeys.join(', ');
        throw new GitImportError(
          'SKILL_HUB_SKILL_NOT_LISTED',
          400,
          `Selected skills are not listed in the explicit skills.json manifest: ${skills}`,
          {
            key: 'Selected skills are not listed in the explicit skills.json manifest: {{skills}}',
            values: { skills },
          },
        );
      }
    }

    const results: Array<Record<string, unknown>> = [];
    const skillRepo = ctx.db.getRepository('skillDefinitions');

    for (const key of selectedSkillKeys) {
      const meta: SkillManifestEntry = manifest.get(key) || { folder: key, name: key };
      const isPluginSkill = isPluginStorage(meta);
      const rawName = meta.name || meta.pluginSource || meta.folder || key;
      const skillName = `${prefix}${rawName}`;
      const skillsSubDir = meta.folder ? joinGitPath(skillsRoot.path, meta.folder) : '';
      const skillBaseDir = skillsSubDir || rootFolder;

      try {
        let frontmatter: SkillManifestEntry = {};
        let instructions = '';

        if (skillBaseDir || !meta.folder) {
          const skillMarkdown = await readOptionalGitFile(
            service,
            repositoryId,
            commitSha,
            access,
            joinGitPath(skillBaseDir, 'SKILL.md'),
          );
          if (skillMarkdown) {
            try {
              const parsed = parseSkillMarkdown(skillMarkdown);
              frontmatter = parsed.metadata;
              instructions = parsed.body;

              const otherMarkdown = await fetchAllMarkdownInFolder(
                service,
                repositoryId,
                commitSha,
                access,
                skillBaseDir,
              );
              if (otherMarkdown) instructions += otherMarkdown;
            } catch (error) {
              if (isFatalGitContentError(error)) {
                throw error;
              }
              // SKILL.md is optional; malformed optional metadata must not
              // prevent a manifest-defined skill from being imported.
            }
          }
        }

        const storageType = normalizeStorageType(
          frontmatter.storageType || meta.storageType || (isPluginSkill ? 'plugin' : 'git'),
        );
        const pluginSource =
          frontmatter.pluginSource || meta.pluginSource || (storageType === 'plugin' ? rawName : undefined);

        let detectedLanguage = frontmatter.language || meta.language || 'python';
        let codeTemplate = frontmatter.codeTemplate || meta.codeTemplate || '';

        if (!codeTemplate && meta.codeFile) {
          codeTemplate = await readOptionalGitFile(
            service,
            repositoryId,
            commitSha,
            access,
            joinGitPath(skillBaseDir, meta.codeFile),
          );
        }

        if (!codeTemplate && storageType !== 'plugin') {
          const codeFile = await readConventionalCodeFile(service, repositoryId, commitSha, access, skillBaseDir);
          if (codeFile) {
            codeTemplate = codeFile.content;
            detectedLanguage = codeFile.language;
          }
        }

        const toolName = buildSkillToolName(skillName);
        const merged: SkillDefinitionValues = {
          name: skillName,
          toolName,
          title: frontmatter.title || meta.title || rawName,
          description: frontmatter.description || meta.description || '',
          language: detectedLanguage,
          storageType,
          storageUrl:
            storageType === 'plugin'
              ? `git://${repositoryId}/${rootFolder || ''}@${commitSha}#${pluginSource || rawName}`
              : `git://${repositoryId}/${skillsSubDir || rootFolder || ''}@${commitSha}`,
          timeoutSeconds: parseInteger(frontmatter.timeoutSeconds ?? meta.timeoutSeconds, 60),
          maxOutputSizeMb: parseInteger(frontmatter.maxOutputSizeMb ?? meta.maxOutputSizeMb, 50),
          toolScope: frontmatter.toolScope || meta.toolScope || 'CUSTOM',
          enabled: parseBoolean(frontmatter.enabled ?? meta.enabled, true),
          autoCall: parseBoolean(frontmatter.autoCall ?? meta.autoCall, false),
          packages: stringifyJsonText(parseJsonLike(meta.packages ?? frontmatter.packages, []), []),
        };

        if (codeTemplate) {
          merged.codeTemplate = codeTemplate;
        }
        if (pluginSource) {
          merged.pluginSource = pluginSource;
        }
        if (instructions) {
          merged.instructions = instructions.trim();
        }

        const inputSchema = parseJsonLike(frontmatter.inputSchema ?? meta.inputSchema, null);
        if (inputSchema) {
          merged.inputSchema = stringifyJsonText(inputSchema);
        }

        const interactionSchema = parseJsonLike(frontmatter.interactionSchema ?? meta.interactionSchema, null);
        if (interactionSchema) {
          merged.interactionSchema = stringifyJsonText(interactionSchema);
        }

        const existing = await skillRepo.findOne({ filter: { name: skillName } });
        if (existing && !overwrite) {
          results.push({ folder: key, name: skillName, status: 'skipped', reason: 'Already exists' });
          continue;
        }

        if (existing) {
          delete merged.toolName;
          await skillRepo.update({ filterByTk: existing.get('id'), values: merged });
          results.push({ folder: key, name: skillName, status: 'updated' });
        } else {
          await assertSkillToolNameAvailable(ctx.db, toolName);
          await skillRepo.create({ values: merged });
          results.push({ folder: key, name: skillName, status: 'created' });
        }
      } catch (error) {
        if (isFatalGitContentError(error)) {
          throw error;
        }
        results.push({ folder: key, name: skillName, status: 'error', reason: errorMessage(error) });
      }
    }

    ctx.body = { data: results };
    await next();
  } catch (error) {
    throwGitImportError(ctx, error);
  }
}

function getGitManagerContentService(ctx: Context): GitManagerContentService {
  const pluginManager = (ctx.app as unknown as { pm?: GitManagerPluginManager }).pm;
  const plugin = pluginManager?.get('plugin-git-manager');
  if (!plugin || typeof plugin !== 'object') {
    throw new GitImportError(
      'GIT_MANAGER_CONTENT_UNAVAILABLE',
      424,
      'Git Manager is not enabled for Skill Hub imports.',
      { key: 'Git Manager is not enabled for Skill Hub imports.' },
    );
  }

  const service = (plugin as GitManagerPlugin).skillHubContentService;
  if (!service || typeof service !== 'object') {
    throw new GitImportError(
      'GIT_MANAGER_CONTENT_UNAVAILABLE',
      424,
      'Git Manager must support actor-aware content reads for Skill Hub imports.',
      { key: 'Git Manager must support actor-aware content reads for Skill Hub imports.' },
    );
  }

  const candidate = service as Partial<GitManagerContentService>;
  const contractVersion = candidate.contractVersion;
  const capabilities = candidate.capabilities;
  const hasCompatibleContract =
    typeof contractVersion === 'number' &&
    Number.isSafeInteger(contractVersion) &&
    contractVersion >= GIT_MANAGER_CONTENT_CONTRACT_VERSION;
  if (
    !hasCompatibleContract ||
    !Array.isArray(capabilities) ||
    !capabilities.includes(GIT_MANAGER_CONTENT_CAPABILITY) ||
    typeof candidate.resolveCommit !== 'function' ||
    typeof candidate.listTree !== 'function' ||
    typeof candidate.readFile !== 'function'
  ) {
    throw new GitImportError(
      'GIT_MANAGER_CONTENT_UNAVAILABLE',
      424,
      'Git Manager must support actor-aware content reads for Skill Hub imports.',
      { key: 'Git Manager must support actor-aware content reads for Skill Hub imports.' },
    );
  }
  return service as GitManagerContentService;
}

function accessFromContext(ctx: Context): GitManagerAccessContext {
  const currentRoles = (ctx.state as unknown as { currentRoles?: unknown } | undefined)?.currentRoles;
  if (!Array.isArray(currentRoles) || !currentRoles.every((role): role is string => typeof role === 'string')) {
    throw new GitImportError(
      'SKILL_HUB_REPOSITORY_ACCESS_DENIED',
      403,
      'A valid user role context is required to import skills from Git Manager.',
      { key: 'A valid user role context is required to import skills from Git Manager.' },
    );
  }
  return { kind: 'user', roles: currentRoles };
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingGitFile(error: unknown): boolean {
  return errorCode(error) === MISSING_GIT_FILE_CODE;
}

function isFatalGitContentError(error: unknown): boolean {
  if (error instanceof GitImportError) return true;
  const code = errorCode(error);
  return code === ACCESS_DENIED_CODE || code === CONTENT_LIMIT_CODE;
}

function throwGitImportError(ctx: Context, error: unknown): never {
  if (error instanceof GitImportError) {
    return throwHttpError(ctx, error.status, error.message, error.translation);
  }

  switch (errorCode(error)) {
    case ACCESS_DENIED_CODE:
      return throwHttpError(ctx, 403, errorMessage(error));
    case CONTENT_LIMIT_CODE:
      return throwHttpError(ctx, 422, errorMessage(error));
    case MISSING_GIT_FILE_CODE:
      return throwHttpError(ctx, 404, errorMessage(error));
    default:
      return throwHttpError(ctx, 502, 'Git Manager could not read the requested repository content.', {
        key: 'Git Manager could not read the requested repository content.',
      });
  }
}

function translateGitImportMessage(
  ctx: Context,
  key: string,
  values?: Record<string, string | number>,
  fallback = key,
): string {
  const translate = (ctx as unknown as { t?: unknown }).t;
  if (typeof translate !== 'function') {
    return fallback;
  }
  const translated = translate(key, { ns: GIT_IMPORT_NAMESPACE, ...values });
  return typeof translated === 'string' ? translated : fallback;
}

function throwHttpError(ctx: Context, status: number, message: string, translation?: GitImportTranslation): never {
  const localizedMessage = translation
    ? translateGitImportMessage(ctx, translation.key, translation.values, message)
    : message;
  return (ctx as unknown as { throw(status: number, message: string): never }).throw(status, localizedMessage);
}

async function loadSkillsManifest(
  service: GitManagerContentService,
  repositoryId: string | number,
  commitSha: string,
  access: GitManagerAccessContext,
  configPath: string,
): Promise<{ exists: boolean; config: SkillManifest }> {
  let raw: string;
  try {
    raw = (await service.readFile({ repositoryId, commitSha, filePath: configPath }, access)).toString('utf8');
  } catch (error) {
    if (isMissingGitFile(error)) {
      return { exists: false, config: {} };
    }
    throw error;
  }

  try {
    return { exists: true, config: JSON.parse(raw) as SkillManifest };
  } catch (error) {
    throw new Error(`Invalid ${configPath}: ${errorMessage(error)}`);
  }
}

async function discoverSkills(
  service: GitManagerContentService,
  repositoryId: string | number,
  commitSha: string,
  access: GitManagerAccessContext,
  rootFolder: string,
  skillsRoot: ResolvedSkillsRoot,
): Promise<SkillManifestEntry[]> {
  if (skillsRoot.folders.length > 0) {
    return skillsRoot.folders;
  }

  const pluginSkill = await discoverPluginSkill(service, repositoryId, commitSha, access, rootFolder);
  return pluginSkill ? [pluginSkill] : [];
}

type ResolvedSkillsRoot = {
  path: string;
  folders: SkillManifestEntry[];
};

async function resolveSkillsRoot(
  service: GitManagerContentService,
  repositoryId: string | number,
  commitSha: string,
  access: GitManagerAccessContext,
  rootFolder: string,
): Promise<ResolvedSkillsRoot> {
  const configuredRoot = normalizeRootFolder(rootFolder);
  const rootEntries = await service.listTree(
    { repositoryId, commitSha, rootPath: configuredRoot, recursive: false },
    access,
  );
  const configuredRootIsSkillsDirectory = configuredRoot === 'skills' || configuredRoot.endsWith('/skills');
  const directFolders = await discoverSkillFoldersAtRoot(
    service,
    repositoryId,
    commitSha,
    access,
    configuredRoot,
    rootEntries,
  );
  if (directFolders.length > 0 || configuredRootIsSkillsDirectory) {
    return { path: configuredRoot, folders: directFolders };
  }

  const hasSkillsSubfolder = rootEntries.some((entry) => entry.type === 'tree' && entry.path === 'skills');
  if (!hasSkillsSubfolder) {
    return { path: configuredRoot, folders: directFolders };
  }

  const fallbackRoot = joinGitPath(configuredRoot, 'skills');
  return {
    path: fallbackRoot,
    folders: await discoverSkillFoldersAtRoot(service, repositoryId, commitSha, access, fallbackRoot),
  };
}

async function discoverSkillFoldersAtRoot(
  service: GitManagerContentService,
  repositoryId: string | number,
  commitSha: string,
  access: GitManagerAccessContext,
  baseDir: string,
  rootEntries?: GitTreeEntry[],
): Promise<SkillManifestEntry[]> {
  try {
    const entries =
      rootEntries || (await service.listTree({ repositoryId, commitSha, rootPath: baseDir, recursive: false }, access));
    const folders = entries.filter((entry) => entry.type === 'tree').map((entry) => entry.path);
    const discovered: SkillManifestEntry[] = [];
    const batchSize = 16;
    for (let offset = 0; offset < folders.length; offset += batchSize) {
      const batch = folders.slice(offset, offset + batchSize);
      const results = await Promise.all(
        batch.map(async (folder) => {
          const folderEntries = await service.listTree(
            { repositoryId, commitSha, rootPath: joinGitPath(baseDir, folder), recursive: false },
            access,
          );
          return folderEntries.some((entry) => entry.type === 'blob' && entry.path === 'SKILL.md') ? folder : null;
        }),
      );
      for (const folder of results) {
        if (folder) {
          discovered.push({ folder, name: folder, title: folder, storageType: 'git' });
        }
      }
    }
    return discovered;
  } catch (error) {
    if (isMissingGitFile(error)) {
      return [];
    }
    throw error;
  }
}

async function discoverPluginSkill(
  service: GitManagerContentService,
  repositoryId: string | number,
  commitSha: string,
  access: GitManagerAccessContext,
  rootFolder: string,
): Promise<SkillManifestEntry | null> {
  const packageJsonPath = joinGitPath(rootFolder, 'package.json');
  const rawPackageJson = await readOptionalGitFile(service, repositoryId, commitSha, access, packageJsonPath);
  if (!rawPackageJson) {
    return null;
  }

  let packageJson: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawPackageJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    packageJson = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const definition =
    (await readOptionalGitFile(
      service,
      repositoryId,
      commitSha,
      access,
      joinGitPath(rootFolder, 'src/server/skill-definition.ts'),
    )) ||
    (await readOptionalGitFile(
      service,
      repositoryId,
      commitSha,
      access,
      joinGitPath(rootFolder, 'src/server/skill-definition.js'),
    ));
  const templateName = definition ? extractStringProperty(definition, 'name') : null;
  const title = definition ? extractStringProperty(definition, 'title') : null;
  const language = definition ? extractStringProperty(definition, 'language') : null;

  const packageName = stringValue(packageJson.name);
  const pluginSource = templateName || packageName;
  if (!pluginSource) {
    return null;
  }

  return {
    name: pluginSource,
    title: title || stringValue(packageJson.displayName) || packageName || pluginSource,
    description: stringValue(packageJson.description) || '',
    language: language || 'python',
    storageType: 'plugin',
    pluginSource,
  };
}

function createSkillsManifest(rootFolder: string, skills: SkillManifestEntry[]): SkillManifest {
  return {
    name: rootFolder || 'skills',
    description: '',
    initializedAt: new Date().toISOString(),
    skills,
  };
}

async function readConventionalCodeFile(
  service: GitManagerContentService,
  repositoryId: string | number,
  commitSha: string,
  access: GitManagerAccessContext,
  skillsSubDir: string,
) {
  for (const [file, language] of CODE_FILES) {
    const content = await readOptionalGitFile(
      service,
      repositoryId,
      commitSha,
      access,
      joinGitPath(skillsSubDir, file),
    );
    if (content) {
      return { content, language };
    }
  }
  return null;
}

async function readOptionalGitFile(
  service: GitManagerContentService,
  repositoryId: string | number,
  commitSha: string,
  access: GitManagerAccessContext,
  filePath: string,
  maxBytes?: number,
): Promise<string> {
  try {
    const input =
      maxBytes === undefined ? { repositoryId, commitSha, filePath } : { repositoryId, commitSha, filePath, maxBytes };
    return (await service.readFile(input, access)).toString('utf8');
  } catch (error) {
    if (isMissingGitFile(error)) {
      return '';
    }
    throw error;
  }
}

function enrichListedSkill(skill: SkillManifestEntry, prefix: string) {
  const rawName = skill.name || skill.pluginSource || skill.folder || '';
  const finalName = `${prefix}${rawName}`;

  return {
    folder: getSkillKey(skill),
    name: finalName,
    title: skill.title || rawName,
    description: skill.description || '',
    language: skill.language || 'python',
    storageType: normalizeStorageType(skill.storageType || (skill.pluginSource ? 'plugin' : 'git')),
    pluginSource: skill.pluginSource,
    ...(skill.timeoutSeconds ? { timeoutSeconds: skill.timeoutSeconds } : {}),
    ...(skill.maxOutputSizeMb ? { maxOutputSizeMb: skill.maxOutputSizeMb } : {}),
    ...(skill.packages ? { packages: skill.packages } : {}),
    ...(skill.inputSchema ? { inputSchema: skill.inputSchema } : {}),
    ...(skill.toolScope ? { toolScope: skill.toolScope } : {}),
  };
}

function getSkillKey(skill: SkillManifestEntry) {
  return String(skill.folder || skill.name || skill.pluginSource || '').trim();
}

function isPluginStorage(skill: SkillManifestEntry) {
  return normalizeStorageType(skill.storageType) === 'plugin' || !!skill.pluginSource;
}

function normalizeStorageType(storageType: unknown) {
  const value = typeof storageType === 'string' ? storageType.toLowerCase() : '';
  if (value === 'plugin') return 'plugin';
  if (value === 'local') return 'local';
  if (value === 'database') return 'database';
  return 'git';
}

function parseInteger(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value: unknown, fallback: boolean) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return !['false', '0', 'no'].includes(value.toLowerCase());
  return Boolean(value);
}

function extractStringProperty(source: string, property: string) {
  const match = source.match(new RegExp(property + '\\s*:\\s*([\'"\\x60])([\\s\\S]*?)\\1'));
  return match ? match[2] : null;
}

function normalizeRootFolder(rootFolder: unknown) {
  if (rootFolder === undefined || rootFolder === null) {
    throw new Error('repositoryId and rootFolder are required');
  }

  const normalized = String(rootFolder)
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (normalized.includes('..') || normalized.includes('\0')) {
    throw new Error('Invalid rootFolder');
  }
  return normalized;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function joinGitPath(...parts: Array<string | undefined>) {
  return parts
    .filter((part) => part !== undefined && part !== '')
    .join('/')
    .replace(/\/+/g, '/');
}

function markdownContentHeader(path: string): string {
  return `\n\n--- Content from ${path} ---\n\n`;
}

function markdownContentLimitError(message: string, translation?: GitImportTranslation): GitImportError {
  return new GitImportError('REGISTRY_CONTENT_LIMIT_EXCEEDED', 422, message, translation);
}

async function fetchAllMarkdownInFolder(
  service: GitManagerContentService,
  repositoryId: string | number,
  commitSha: string,
  access: GitManagerAccessContext,
  folderPath: string,
): Promise<string> {
  try {
    const entries = await service.listTree({ repositoryId, commitSha, rootPath: folderPath, recursive: true }, access);
    const markdownEntries = entries
      .filter(
        (entry) =>
          entry.type === 'blob' && entry.path.toLowerCase().endsWith('.md') && entry.path.toUpperCase() !== 'SKILL.MD',
      )
      .sort((left, right) => left.path.localeCompare(right.path));
    if (markdownEntries.length > GIT_SKILL_MARKDOWN_LIMITS.maxFiles) {
      throw markdownContentLimitError(
        `Git skill contains more than ${GIT_SKILL_MARKDOWN_LIMITS.maxFiles} supplemental Markdown files.`,
        {
          key: 'Git skill contains more than {{count}} supplemental Markdown files.',
          values: { count: GIT_SKILL_MARKDOWN_LIMITS.maxFiles },
        },
      );
    }

    let declaredBytes = 0;
    for (const entry of markdownEntries) {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
        throw markdownContentLimitError('Git skill contains a supplemental Markdown file with an invalid size.', {
          key: 'Git skill contains a supplemental Markdown file with an invalid size.',
        });
      }
      declaredBytes += Buffer.byteLength(markdownContentHeader(entry.path), 'utf8') + entry.size;
      if (declaredBytes > GIT_SKILL_MARKDOWN_LIMITS.maxBytes) {
        throw markdownContentLimitError(
          `Git skill supplemental Markdown exceeds ${GIT_SKILL_MARKDOWN_LIMITS.maxBytes} bytes.`,
          {
            key: 'Git skill supplemental Markdown exceeds {{maxBytes}} bytes.',
            values: { maxBytes: GIT_SKILL_MARKDOWN_LIMITS.maxBytes },
          },
        );
      }
    }

    let combined = '';
    let combinedBytes = 0;
    for (const entry of markdownEntries) {
      const header = markdownContentHeader(entry.path);
      const remainingContentBytes =
        GIT_SKILL_MARKDOWN_LIMITS.maxBytes - combinedBytes - Buffer.byteLength(header, 'utf8');
      if (remainingContentBytes <= 0) {
        throw markdownContentLimitError(
          `Git skill supplemental Markdown exceeds ${GIT_SKILL_MARKDOWN_LIMITS.maxBytes} bytes.`,
          {
            key: 'Git skill supplemental Markdown exceeds {{maxBytes}} bytes.',
            values: { maxBytes: GIT_SKILL_MARKDOWN_LIMITS.maxBytes },
          },
        );
      }
      const content = await readOptionalGitFile(
        service,
        repositoryId,
        commitSha,
        access,
        joinGitPath(folderPath, entry.path),
        remainingContentBytes,
      );
      if (content) {
        const contentBytes = Buffer.byteLength(content, 'utf8');
        if (contentBytes > remainingContentBytes) {
          throw markdownContentLimitError(
            `Git skill supplemental Markdown exceeds ${GIT_SKILL_MARKDOWN_LIMITS.maxBytes} bytes.`,
            {
              key: 'Git skill supplemental Markdown exceeds {{maxBytes}} bytes.',
              values: { maxBytes: GIT_SKILL_MARKDOWN_LIMITS.maxBytes },
            },
          );
        }
        combined += header + content;
        combinedBytes += Buffer.byteLength(header, 'utf8') + contentBytes;
      }
    }
    return combined;
  } catch (error) {
    if (isMissingGitFile(error)) {
      return '';
    }
    throw error;
  }
}
