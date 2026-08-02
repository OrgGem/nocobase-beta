import type {
  JsonValue,
  RegistrySkillCandidateV1,
  RegistrySkillFile,
  RegistrySourceAccessContext,
  RegistrySourceDescriptor,
  RegistrySourceProvider,
} from '../contracts/types';
import { asJsonValue, isRecord } from '../contracts/types';
import { RegistryError } from '../contracts/errors';
import { ARTIFACT_LIMITS } from '../services/artifact-builder';
import { SOURCE_INGESTION_LIMITS, validateDiscoveredExternalKeys } from '../services/candidate-validator';
import { candidateDigest } from '../services/canonical-json';
import { normalizeIdentity, normalizeRelativePath } from '../services/validation';

interface GitTreeEntry {
  type: 'blob' | 'tree';
  path: string;
  size: number;
}

interface GitManagerContentService {
  contractVersion?: number;
  capabilities?: readonly string[];
  assertRepositoryAccess?(repositoryId: string | number, access?: RegistrySourceAccessContext): Promise<void>;
  resolveCommit(repositoryId: string | number, ref: string, access?: RegistrySourceAccessContext): Promise<string>;
  listTree(
    input: {
      repositoryId: string | number;
      commitSha: string;
      rootPath: string;
      recursive: boolean;
    },
    access?: RegistrySourceAccessContext,
  ): Promise<GitTreeEntry[]>;
  readFile(
    input: {
      repositoryId: string | number;
      commitSha: string;
      filePath: string;
      maxBytes?: number;
    },
    access?: RegistrySourceAccessContext,
  ): Promise<Buffer>;
}

type PluginManager = {
  get(name: string): unknown;
};

type GitSourceConfig = {
  repositoryId: string | number;
  ref: string;
  rootPath: string;
};

async function requireGitExport<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (isRecord(error) && error.code === 'REGISTRY_EXPORT_NOT_GRANTED') {
      throw new RegistryError(
        'SOURCE_EXPORT_NOT_GRANTED',
        403,
        'Git Manager repository is not authorized for Skill Registry export.',
      );
    }
    if (isRecord(error) && error.code === 'REGISTRY_REPOSITORY_ACCESS_DENIED') {
      throw new RegistryError(
        'SOURCE_REPOSITORY_ACCESS_DENIED',
        403,
        'The current actor is not authorized to read this Git Manager repository for Skill Registry.',
      );
    }
    if (isRecord(error) && error.code === 'REGISTRY_CONTENT_LIMIT_EXCEEDED') {
      throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Git source content exceeds the registry ingestion limit.');
    }
    throw error;
  }
}

function requireActorAwareGitService(service: GitManagerContentService): void {
  const capabilities = service.capabilities;
  if (
    !Number.isSafeInteger(service.contractVersion) ||
    service.contractVersion < 2 ||
    !Array.isArray(capabilities) ||
    !capabilities.includes('registry-content-with-actor')
  ) {
    throw new RegistryError(
      'SOURCE_PROVIDER_UNAVAILABLE',
      424,
      'Git Manager must support actor-aware registry content reads.',
    );
  }
}

function requireSourceAuthorizationService(service: GitManagerContentService): void {
  requireActorAwareGitService(service);
  if (
    typeof service.assertRepositoryAccess !== 'function' ||
    !service.capabilities?.includes('registry-content-authorize-source')
  ) {
    throw new RegistryError(
      'SOURCE_PROVIDER_UNAVAILABLE',
      424,
      'Git Manager must support source authorization for Skill Registry.',
    );
  }
}

function resolveCommit(
  service: GitManagerContentService,
  repositoryId: string | number,
  ref: string,
  access?: RegistrySourceAccessContext,
): Promise<string> {
  return access ? service.resolveCommit(repositoryId, ref, access) : service.resolveCommit(repositoryId, ref);
}

function listTree(
  service: GitManagerContentService,
  input: { repositoryId: string | number; commitSha: string; rootPath: string; recursive: boolean },
  access?: RegistrySourceAccessContext,
): Promise<GitTreeEntry[]> {
  return access ? service.listTree(input, access) : service.listTree(input);
}

function readFile(
  service: GitManagerContentService,
  input: { repositoryId: string | number; commitSha: string; filePath: string; maxBytes?: number },
  access?: RegistrySourceAccessContext,
): Promise<Buffer> {
  return access ? service.readFile(input, access) : service.readFile(input);
}

function getGitService(pluginManager: PluginManager): GitManagerContentService {
  const plugin = pluginManager.get('plugin-git-manager');
  if (!plugin || typeof plugin !== 'object') {
    throw new RegistryError('SOURCE_PROVIDER_UNAVAILABLE', 424, 'Git Manager is not enabled.');
  }
  const service = (plugin as { registryContentService?: unknown }).registryContentService;
  if (
    !service ||
    typeof service !== 'object' ||
    typeof (service as { resolveCommit?: unknown }).resolveCommit !== 'function' ||
    typeof (service as { listTree?: unknown }).listTree !== 'function' ||
    typeof (service as { readFile?: unknown }).readFile !== 'function'
  ) {
    throw new RegistryError(
      'SOURCE_PROVIDER_UNAVAILABLE',
      424,
      'Git Manager does not expose its registry content service.',
    );
  }
  return service as GitManagerContentService;
}

function getGitSourceConfig(source: RegistrySourceDescriptor): GitSourceConfig {
  if (!isRecord(source.providerConfig)) {
    throw new RegistryError('INVALID_MANIFEST', 422, 'Git source configuration must be an object.');
  }
  const repositoryId = source.providerConfig.repositoryId;
  const ref = source.providerConfig.ref;
  const rootPath = source.providerConfig.rootPath;
  if ((typeof repositoryId !== 'string' && typeof repositoryId !== 'number') || typeof ref !== 'string') {
    throw new RegistryError('INVALID_MANIFEST', 422, 'Git source requires repositoryId and ref.');
  }
  return {
    repositoryId,
    ref,
    rootPath: typeof rootPath === 'string' ? rootPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : '',
  };
}

function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
}

function normalizeRootPath(rootPath: string): string {
  return rootPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function parseFrontmatter(markdown: string): Record<string, unknown> {
  const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const parsed = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!parsed) {
      continue;
    }
    const raw = parsed[2].trim().replace(/^['"]|['"]$/g, '');
    if (raw === 'true' || raw === 'false') {
      result[parsed[1]] = raw === 'true';
    } else {
      try {
        result[parsed[1]] = JSON.parse(raw);
      } catch {
        result[parsed[1]] = raw;
      }
    }
  }
  return result;
}

function entryKey(entry: Record<string, unknown>): string | null {
  for (const key of ['folder', 'name', 'pluginSource']) {
    if (typeof entry[key] === 'string' && entry[key].trim()) {
      return entry[key].trim();
    }
  }
  return null;
}

function parseSkillsManifest(value: Buffer): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.toString('utf8'));
  } catch {
    throw new RegistryError('INVALID_MANIFEST', 422, 'Git skills.json is not valid JSON.');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.skills)) {
    throw new RegistryError('INVALID_MANIFEST', 422, 'Git skills.json must contain a skills array.');
  }
  const entries: Array<Record<string, unknown>> = [];
  for (const entry of parsed.skills) {
    if (!isRecord(entry) || !entryKey(entry)) {
      throw new RegistryError(
        'INVALID_MANIFEST',
        422,
        'Every Git skills.json entry must declare folder, name, or pluginSource.',
      );
    }
    entries.push(entry);
  }
  return entries;
}

function isMissingOptionalGitFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'REGISTRY_GIT_FILE_NOT_FOUND';
}

async function discoverVirtualSkillFolders(input: {
  service: GitManagerContentService;
  config: GitSourceConfig;
  commitSha: string;
  access?: RegistrySourceAccessContext;
  skillsRoot: string;
  rootEntries?: GitTreeEntry[];
}): Promise<string[]> {
  const rootEntries =
    input.rootEntries ||
    (await requireGitExport(
      listTree(
        input.service,
        {
          repositoryId: input.config.repositoryId,
          commitSha: input.commitSha,
          rootPath: input.skillsRoot,
          recursive: false,
        },
        input.access,
      ),
    ));
  const skillFolders = rootEntries.filter((entry) => entry.type === 'tree').map((entry) => entry.path);

  const discovered: string[] = [];
  const batchSize = 16;
  for (let offset = 0; offset < skillFolders.length; offset += batchSize) {
    const batch = skillFolders.slice(offset, offset + batchSize);
    const results = await Promise.all(
      batch.map(async (folder) => {
        const entries = await requireGitExport(
          listTree(
            input.service,
            {
              repositoryId: input.config.repositoryId,
              commitSha: input.commitSha,
              rootPath: joinPath(input.skillsRoot, folder),
              recursive: false,
            },
            input.access,
          ),
        );
        return entries.some((entry) => entry.type === 'blob' && entry.path === 'SKILL.md') ? folder : null;
      }),
    );
    discovered.push(...results.filter((folder): folder is string => folder !== null));
    // Source item limits apply to confirmed skills, not arbitrary folders in a Git root.
    // This preserves the fallback to a nested `skills` directory in large monorepos.
    validateDiscoveredExternalKeys(discovered);
  }
  return discovered;
}

async function resolveSkillsRoot(input: {
  service: GitManagerContentService;
  config: GitSourceConfig;
  commitSha: string;
  access?: RegistrySourceAccessContext;
}): Promise<{ skillsRoot: string; externalKeys: string[] }> {
  const configuredRoot = normalizeRootPath(input.config.rootPath);
  const rootEntries = await requireGitExport(
    listTree(
      input.service,
      {
        repositoryId: input.config.repositoryId,
        commitSha: input.commitSha,
        rootPath: configuredRoot,
        recursive: false,
      },
      input.access,
    ),
  );
  const configuredRootIsSkillsDirectory = configuredRoot === 'skills' || configuredRoot.endsWith('/skills');
  const directExternalKeys = await discoverVirtualSkillFolders({
    ...input,
    skillsRoot: configuredRoot,
    rootEntries,
  });
  if (directExternalKeys.length > 0 || configuredRootIsSkillsDirectory) {
    return { skillsRoot: configuredRoot, externalKeys: directExternalKeys };
  }

  const hasSkillsSubfolder = rootEntries.some((entry) => entry.type === 'tree' && entry.path === 'skills');
  if (!hasSkillsSubfolder) {
    return { skillsRoot: configuredRoot, externalKeys: directExternalKeys };
  }

  const fallbackRoot = joinPath(configuredRoot, 'skills');
  return {
    skillsRoot: fallbackRoot,
    externalKeys: await discoverVirtualSkillFolders({ ...input, skillsRoot: fallbackRoot }),
  };
}

export class GitManagerSourceProvider implements RegistrySourceProvider {
  readonly type = 'git-manager' as const;
  private readonly pinnedSources = new Map<string, { commitSha: string; skillsRoot?: string }>();

  constructor(private readonly pluginManager: PluginManager) {}

  async assertAccess(source: RegistrySourceDescriptor, access: RegistrySourceAccessContext): Promise<void> {
    const service = getGitService(this.pluginManager);
    requireSourceAuthorizationService(service);
    const config = getGitSourceConfig(source);
    const authorizeRepository = service.assertRepositoryAccess;
    if (typeof authorizeRepository !== 'function') {
      throw new RegistryError(
        'SOURCE_PROVIDER_UNAVAILABLE',
        424,
        'Git Manager must support source authorization for Skill Registry.',
      );
    }
    await requireGitExport(authorizeRepository.call(service, config.repositoryId, access));
  }

  async discover(source: RegistrySourceDescriptor, access?: RegistrySourceAccessContext): Promise<string[]> {
    const service = getGitService(this.pluginManager);
    if (access) {
      requireActorAwareGitService(service);
    }
    const config = getGitSourceConfig(source);
    const commitSha = await requireGitExport(resolveCommit(service, config.repositoryId, config.ref, access));
    this.pinnedSources.set(source.id, { commitSha });
    const skillsJsonPath = joinPath(config.rootPath, 'skills.json');
    try {
      const entries = parseSkillsManifest(
        await requireGitExport(
          readFile(
            service,
            {
              repositoryId: config.repositoryId,
              commitSha,
              filePath: skillsJsonPath,
              maxBytes: SOURCE_INGESTION_LIMITS.maxFileBytes,
            },
            access,
          ),
        ),
      );
      // A present skills.json is authoritative, including an intentionally empty
      // allowlist. Recursive discovery is only safe when the optional file is absent.
      return validateDiscoveredExternalKeys(entries.map((entry) => entryKey(entry) as string));
    } catch (error) {
      if (error instanceof RegistryError) {
        throw error;
      }
      if (!isMissingOptionalGitFile(error)) {
        throw error;
      }
      // Fall through to SKILL.md discovery when the optional skills.json is absent.
    }
    const resolved = await resolveSkillsRoot({ service, config, commitSha, access });
    this.pinnedSources.set(source.id, { commitSha, skillsRoot: resolved.skillsRoot });
    return resolved.externalKeys;
  }

  async getCandidate(
    source: RegistrySourceDescriptor,
    externalKey: string,
    access?: RegistrySourceAccessContext,
  ): Promise<RegistrySkillCandidateV1> {
    const service = getGitService(this.pluginManager);
    if (access) {
      requireActorAwareGitService(service);
    }
    const config = getGitSourceConfig(source);
    const pinned = this.pinnedSources.get(source.id);
    const commitSha =
      pinned?.commitSha || (await requireGitExport(resolveCommit(service, config.repositoryId, config.ref, access)));
    const skillsJsonPath = joinPath(config.rootPath, 'skills.json');
    let entry: Record<string, unknown> | undefined;
    try {
      const entries = parseSkillsManifest(
        await requireGitExport(
          readFile(
            service,
            {
              repositoryId: config.repositoryId,
              commitSha,
              filePath: skillsJsonPath,
              maxBytes: SOURCE_INGESTION_LIMITS.maxFileBytes,
            },
            access,
          ),
        ),
      );
      entry = entries.find((candidate) => entryKey(candidate) === externalKey);
      if (!entry) {
        throw new RegistryError(
          'SOURCE_ITEM_NOT_FOUND',
          404,
          `Git source item ${externalKey} is not declared in skills.json.`,
        );
      }
    } catch (error) {
      if (error instanceof RegistryError) {
        throw error;
      }
      if (!isMissingOptionalGitFile(error)) {
        throw error;
      }
      entry = undefined;
    }

    const skillsRoot =
      pinned?.skillsRoot || (await resolveSkillsRoot({ service, config, commitSha, access })).skillsRoot;
    const folder = typeof entry?.folder === 'string' ? entry.folder : externalKey;
    const skillRoot = joinPath(skillsRoot, folder);
    const declaredCodeFile = (typeof entry?.codeFile === 'string' && entry.codeFile) || undefined;
    const skillMarkdownPath = joinPath(skillRoot, 'SKILL.md');
    const skillMarkdownSize = (
      await requireGitExport(
        listTree(
          service,
          {
            repositoryId: config.repositoryId,
            commitSha,
            rootPath: skillRoot,
            recursive: false,
          },
          access,
        ),
      )
    ).find((item) => item.type === 'blob' && item.path === 'SKILL.md')?.size;
    if (skillMarkdownSize === undefined) {
      throw new RegistryError('INVALID_MANIFEST', 422, `Git source item ${externalKey} has no SKILL.md.`);
    }
    if (
      !Number.isSafeInteger(skillMarkdownSize) ||
      skillMarkdownSize < 0 ||
      skillMarkdownSize > SOURCE_INGESTION_LIMITS.maxFileBytes
    ) {
      throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Git source item contains an oversized SKILL.md.');
    }
    const frontmatterMarkdown = await requireGitExport(
      readFile(
        service,
        {
          repositoryId: config.repositoryId,
          commitSha,
          filePath: skillMarkdownPath,
          maxBytes: Math.max(1, skillMarkdownSize),
        },
        access,
      ),
    );
    const frontmatter = parseFrontmatter(frontmatterMarkdown.toString('utf8'));
    const codeFile = declaredCodeFile || (typeof frontmatter.codeFile === 'string' ? frontmatter.codeFile : undefined);
    const entries = codeFile
      ? await requireGitExport(
          listTree(
            service,
            { repositoryId: config.repositoryId, commitSha, rootPath: skillRoot, recursive: true },
            access,
          ),
        )
      : [{ type: 'blob' as const, path: 'SKILL.md', size: skillMarkdownSize }];
    const fileEntries = entries.filter((item) => item.type === 'blob');
    if (fileEntries.length === 0) {
      throw new RegistryError('INVALID_MANIFEST', 422, `Git source item ${externalKey} has no files.`);
    }
    if (fileEntries.length > Math.max(0, ARTIFACT_LIMITS.maxFiles - 1)) {
      throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Git source item exceeds the artifact file-count limit.');
    }
    let declaredSize = 0;
    for (const file of fileEntries) {
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > SOURCE_INGESTION_LIMITS.maxFileBytes) {
        throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Git source item contains an oversized file.');
      }
      declaredSize += file.size;
      if (!Number.isSafeInteger(declaredSize) || declaredSize > ARTIFACT_LIMITS.maxExpandedBytes) {
        throw new RegistryError('ARTIFACT_TOO_LARGE', 422, 'Git source item exceeds the expanded artifact limit.');
      }
    }
    const files: RegistrySkillFile[] = [];
    for (const file of fileEntries) {
      const relativePath = normalizeRelativePath(file.path);
      const content = await requireGitExport(
        readFile(
          service,
          {
            repositoryId: config.repositoryId,
            commitSha,
            filePath: joinPath(skillRoot, relativePath),
            maxBytes: Math.max(1, file.size),
          },
          access,
        ),
      );
      if (
        !Buffer.isBuffer(content) ||
        content.length !== file.size ||
        content.length > SOURCE_INGESTION_LIMITS.maxFileBytes
      ) {
        throw new RegistryError(
          'SOURCE_CONTENT_CHANGED',
          409,
          'Git source file bytes do not match the pinned tree metadata.',
        );
      }
      files.push({
        path: relativePath,
        content,
      });
    }
    const skillMarkdown = files.find((file) => file.path === 'SKILL.md')?.content.toString('utf8') || '';
    const language = codeFile
      ? (typeof frontmatter.language === 'string' && frontmatter.language) ||
        (typeof entry?.language === 'string' && entry.language) ||
        (codeFile.endsWith('.js') ? 'node' : 'python')
      : 'instruction';
    if (language !== 'python' && language !== 'node' && language !== 'instruction') {
      throw new RegistryError('INVALID_MANIFEST', 422, `Unsupported runtime language ${language}.`);
    }
    const rawName =
      (typeof frontmatter.name === 'string' && frontmatter.name) ||
      (typeof entry?.name === 'string' && entry.name) ||
      folder;
    const namespace = normalizeIdentity(source.namespace, 'namespace');
    const slug = normalizeIdentity(rawName, 'slug');
    const suggestedVersion =
      (typeof frontmatter.version === 'string' && frontmatter.version) ||
      (typeof entry?.version === 'string' && entry.version) ||
      undefined;
    const inputSchema = frontmatter.inputSchema || entry?.inputSchema || { type: 'object', properties: {} };
    const dependencies = frontmatter.dependencies || entry?.dependencies || [];
    const tags = Array.isArray(entry?.tags) ? entry.tags.filter((tag): tag is string => typeof tag === 'string') : [];
    const registryManifest = {
      schemaVersion: 'registry.skill.nocobase.io/v1' as const,
      name: `${namespace}/${slug}`,
      ...(suggestedVersion ? { version: suggestedVersion } : {}),
      displayName:
        (typeof frontmatter.title === 'string' && frontmatter.title) ||
        (typeof entry?.title === 'string' && entry.title) ||
        rawName,
      description:
        (typeof frontmatter.description === 'string' && frontmatter.description) ||
        (typeof entry?.description === 'string' && entry.description) ||
        '',
      runtime: { kind: language, entrypoint: codeFile ? normalizeRelativePath(codeFile) : 'SKILL.md' },
      inputSchema: asJsonValue(inputSchema, { type: 'object', properties: {} }),
      outputSchema: { type: 'object' },
      permissions: { network: 'deny', filesystem: ['workdir:read', 'output:write'] },
      dependencies: asJsonValue(dependencies, []),
      compatibility: { nocobase: '>=2.0.0', agentOrchestrator: '>=1.0.0' },
      tags,
    };
    return {
      contractVersion: 'registry-candidate/v1',
      source: {
        provider: this.type,
        sourceId: source.id,
        externalKey,
        revision: commitSha,
      },
      identity: {
        namespace,
        slug,
        ...(suggestedVersion ? { suggestedVersion } : {}),
      },
      manifest: registryManifest,
      files,
      candidateDigest: candidateDigest(registryManifest, files),
    };
  }

  releaseSource(source: RegistrySourceDescriptor): void {
    this.pinnedSources.delete(source.id);
  }
}
