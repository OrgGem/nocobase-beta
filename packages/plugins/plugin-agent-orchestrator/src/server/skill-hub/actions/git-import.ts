import { Context } from '@nocobase/actions';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { parseJsonText, stringifyJsonText, parseJsonLike, parseSkillMarkdown } from '../utils/json-fields';
import { assertSkillToolNameAvailable, buildSkillToolName } from '../../utils/skill-tool-name';

type SkillManifestEntry = Record<string, any> & {
  folder?: string;
  name?: string;
  title?: string;
  description?: string;
  language?: string;
  storageType?: string;
  pluginSource?: string;
  codeTemplate?: string;
  codeFile?: string;
};

type SkillManifest = {
  name?: string;
  description?: string;
  skills?: SkillManifestEntry[];
  initializedAt?: string;
};

const CODE_FILES = [
  ['index.py', 'python'],
  ['index.js', 'node'],
  ['main.py', 'python'],
] as const;

/**
 * Git integration actions for skill-hub.
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
    ctx.throw(400, 'repositoryId and rootFolder are required');
  }

  const gitPlugin = ctx.app.pm.get('plugin-git-manager') as any;
  if (!gitPlugin) {
    ctx.throw(400, 'plugin-git-manager is not installed');
  }

  try {
    const repo = await ctx.db.getRepository('gitRepositories').findOne({ filterByTk: repositoryId });
    if (!repo) ctx.throw(404, 'Repository not found');

    const simpleGit = require('simple-git').default;
    const localPath = getLocalPath(repo.get('localPath'));
    const git = simpleGit(localPath);
    const configPath = joinGitPath(rootFolder, 'skills.json');

    const loaded = await loadSkillsManifest(git, ref, localPath, configPath);
    let config = loaded.config;
    let initialized = false;

    if (!loaded.exists) {
      const discovered = await discoverSkills(git, ref, rootFolder);
      config = createSkillsManifest(rootFolder, discovered);
      initialized = initSkillsManifestFile(localPath, configPath, config);
    }

    const manifestSkills = Array.isArray(config.skills) ? config.skills.filter((skill) => getSkillKey(skill)) : [];
    const enriched = manifestSkills.map((skill) => enrichListedSkill(skill, prefix));

    const existingSkills = enriched.length
      ? await ctx.db.getRepository('skillDefinitions').find({
          filter: { name: { $in: enriched.map((s) => s.name) } },
          fields: ['name'],
        })
      : [];
    const existingNames = new Set(existingSkills.map((s: any) => s.get('name')));

    ctx.body = {
      data: enriched.map((s) => ({
        ...s,
        existsInDb: existingNames.has(s.name),
      })),
      config: {
        name: config.name || rootFolder || 'skills',
        description: config.description || '',
        rootFolder,
        path: configPath,
        initializedSkillsJson: initialized,
      },
    };
    await next();
  } catch (err: any) {
    ctx.throw(400, err.message);
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
    ctx.throw(400, 'repositoryId, rootFolder and skills[] are required');
  }

  const repo = await ctx.db.getRepository('gitRepositories').findOne({ filterByTk: repositoryId });
  if (!repo) ctx.throw(404, 'Repository not found');

  const simpleGit = require('simple-git').default;
  const localPath = getLocalPath(repo.get('localPath'));
  const git = simpleGit(localPath);
  const configPath = joinGitPath(rootFolder, 'skills.json');

  const loaded = await loadSkillsManifest(git, ref, localPath, configPath);
  let config = loaded.config;
  if (!loaded.exists) {
    const discovered = await discoverSkills(git, ref, rootFolder);
    config = createSkillsManifest(rootFolder, discovered);
    initSkillsManifestFile(localPath, configPath, config);
  }

  const manifest = new Map<string, SkillManifestEntry>();
  for (const entry of config.skills || []) {
    const key = getSkillKey(entry);
    if (key) {
      manifest.set(key, entry);
    }
  }

  const results: any[] = [];
  const skillRepo = ctx.db.getRepository('skillDefinitions');

  for (const key of selectedKeys) {
    const meta: SkillManifestEntry = manifest.get(key) || { folder: key, name: key };
    const isPluginSkill = isPluginStorage(meta);
    const rawName = meta.name || meta.pluginSource || meta.folder || key;
    const skillName = `${prefix}${rawName}`;
    const skillsSubDir = meta.folder ? joinGitPath(rootFolder, 'skills', meta.folder) : '';
    const skillBaseDir = skillsSubDir || rootFolder;

    try {
      let frontmatter: Record<string, any> = {};
      let instructions = '';

      if (skillBaseDir || !meta.folder) {
        try {
          const skillMd = await git.show([`${ref}:${joinGitPath(skillBaseDir, 'SKILL.md')}`]);
          const parsed = parseSkillMarkdown(skillMd);
          frontmatter = parsed.metadata;
          instructions = parsed.body;

          const otherMds = await fetchAllMarkdownInFolder(git, ref, skillBaseDir);
          if (otherMds) instructions += otherMds;
        } catch {
          // SKILL.md is optional; manifest data is enough.
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
        codeTemplate = await readOptionalGitFile(git, ref, joinGitPath(skillBaseDir, meta.codeFile));
      }

      if (!codeTemplate && storageType !== 'plugin') {
        const codeFile = await readConventionalCodeFile(git, ref, skillBaseDir);
        if (codeFile) {
          codeTemplate = codeFile.content;
          detectedLanguage = codeFile.language;
        }
      }

      const merged: Record<string, any> = {
        name: skillName,
        toolName: buildSkillToolName(skillName),
        title: frontmatter.title || meta.title || rawName,
        description: frontmatter.description || meta.description || '',
        language: detectedLanguage,
        storageType,
        storageUrl:
          storageType === 'plugin'
            ? `git://${repositoryId}/${rootFolder || ''}@${ref}#${pluginSource || rawName}`
            : `git://${repositoryId}/${skillsSubDir || rootFolder || ''}@${ref}`,
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
        await assertSkillToolNameAvailable(ctx.db, merged.toolName);
        await skillRepo.create({ values: merged });
        results.push({ folder: key, name: skillName, status: 'created' });
      }
    } catch (err: any) {
      results.push({ folder: key, name: skillName, status: 'error', reason: err.message });
    }
  }

  ctx.body = { data: results };
  await next();
}

async function loadSkillsManifest(git: any, ref: string, localPath: string, configPath: string) {
  let raw: string | null = null;

  try {
    raw = await git.show([`${ref}:${configPath}`]);
  } catch {
    const filePath = resolveRepoFile(localPath, configPath);
    if (existsSync(filePath)) {
      raw = readFileSync(filePath, 'utf8');
    }
  }

  if (!raw) {
    return { exists: false, config: {} as SkillManifest };
  }

  try {
    return { exists: true, config: JSON.parse(raw) as SkillManifest };
  } catch (err: any) {
    throw new Error(`Invalid ${configPath}: ${err.message}`);
  }
}

async function discoverSkills(git: any, ref: string, rootFolder: string): Promise<SkillManifestEntry[]> {
  const folderSkills = await discoverSkillFolders(git, ref, rootFolder);
  if (folderSkills.length > 0) {
    return folderSkills;
  }

  const pluginSkill = await discoverPluginSkill(git, ref, rootFolder);
  return pluginSkill ? [pluginSkill] : [];
}

async function discoverSkillFolders(git: any, ref: string, rootFolder: string): Promise<SkillManifestEntry[]> {
  const baseDir = joinGitPath(rootFolder, 'skills');

  try {
    const dirs = await git.raw(['ls-tree', '-d', '--name-only', `${ref}:${baseDir}/`]);
    return dirs
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((folder: string) => ({
        folder,
        name: folder,
        title: folder,
        storageType: 'git',
      }));
  } catch {
    return [];
  }
}

async function discoverPluginSkill(git: any, ref: string, rootFolder: string): Promise<SkillManifestEntry | null> {
  const packageJsonPath = joinGitPath(rootFolder, 'package.json');
  let packageJson: any;

  try {
    packageJson = JSON.parse(await git.show([`${ref}:${packageJsonPath}`]));
  } catch {
    return null;
  }

  const definition =
    (await readOptionalGitFile(git, ref, joinGitPath(rootFolder, 'src/server/skill-definition.ts'))) ||
    (await readOptionalGitFile(git, ref, joinGitPath(rootFolder, 'src/server/skill-definition.js')));
  const templateName = definition ? extractStringProperty(definition, 'name') : null;
  const title = definition ? extractStringProperty(definition, 'title') : null;
  const language = definition ? extractStringProperty(definition, 'language') : null;

  const pluginSource = templateName || packageJson.name;
  if (!pluginSource) {
    return null;
  }

  return {
    name: pluginSource,
    title: title || packageJson.displayName || packageJson.name || pluginSource,
    description: packageJson.description || '',
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

function initSkillsManifestFile(localPath: string, configPath: string, config: SkillManifest) {
  const filePath = resolveRepoFile(localPath, configPath);
  if (existsSync(filePath)) {
    return false;
  }

  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return true;
}

async function readConventionalCodeFile(git: any, ref: string, skillsSubDir: string) {
  for (const [file, language] of CODE_FILES) {
    const content = await readOptionalGitFile(git, ref, joinGitPath(skillsSubDir, file));
    if (content) {
      return { content, language };
    }
  }
  return null;
}

async function readOptionalGitFile(git: any, ref: string, filePath: string): Promise<string> {
  try {
    return await git.show([`${ref}:${filePath}`]);
  } catch {
    return '';
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

function normalizeStorageType(storageType: any) {
  const value = typeof storageType === 'string' ? storageType.toLowerCase() : '';
  if (value === 'plugin') return 'plugin';
  if (value === 'local') return 'local';
  if (value === 'database') return 'database';
  return 'git';
}

function parseInteger(value: any, fallback: number) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value: any, fallback: boolean) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return !['false', '0', 'no'].includes(value.toLowerCase());
  return Boolean(value);
}

function extractStringProperty(source: string, property: string) {
  const match = source.match(new RegExp(`${property}\\s*:\\s*(['"\`])([\\s\\S]*?)\\1`));
  return match ? match[2] : null;
}

function normalizeRootFolder(rootFolder: any) {
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

function joinGitPath(...parts: Array<string | undefined>) {
  return parts
    .filter((part) => part !== undefined && part !== '')
    .join('/')
    .replace(/\/+/g, '/');
}

function resolveRepoFile(localPath: string, gitPath: string): string {
  const basePath = path.resolve(localPath);
  const resolved = path.resolve(basePath, ...gitPath.split('/').filter(Boolean));
  if (resolved !== basePath && !resolved.startsWith(basePath + path.sep)) {
    throw new Error('Invalid file path');
  }
  return resolved;
}

function getLocalPath(localPath: string): string {
  const basePath = process.env.GIT_REPOS_BASE_PATH || path.join(process.cwd(), 'storage', 'git-repos');
  if (path.isAbsolute(localPath)) return localPath;
  return path.resolve(basePath, localPath);
}

async function fetchAllMarkdownInFolder(git: any, ref: string, folderPath: string): Promise<string> {
  let combined = '';
  try {
    const filesOut = await git.raw(['ls-tree', '-r', '--name-only', `${ref}:${folderPath}/`]);
    const files = filesOut.trim().split('\n').filter(Boolean);

    for (const file of files) {
      if (file.toLowerCase().endsWith('.md') && file.toUpperCase() !== 'SKILL.md') {
        const content = await readOptionalGitFile(git, ref, joinGitPath(folderPath, file));
        if (content) {
          combined += `\n\n--- Content from ${file} ---\n\n${content}`;
        }
      }
    }
  } catch (err) {
    // Optional folder expansion can fail for missing paths or refs; keep import best-effort.
  }
  return combined;
}
