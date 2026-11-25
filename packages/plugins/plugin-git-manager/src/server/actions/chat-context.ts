// SPDX-License-Identifier: Apache-2.0

import type { Context } from '@nocobase/actions';
import type { Filter } from '@nocobase/database';
import { getEffectiveActionParams, resolveRepositoryScope, scopeIncludesRepository } from '../repository-access';
import { readChatCommit } from './git-actions';
import { readChatMergeRequest } from './gitlab-api';

const MAX_FILES = 50;
const MAX_DIFF_BYTES = 24 * 1024;
const REPOSITORY_FIELDS = ['id', 'name', 'defaultBranch', 'status'] as const;
const KINDS = ['repository', 'merge-request', 'commit'] as const;
type Kind = (typeof KINDS)[number];
type RepositoryField = (typeof REPOSITORY_FIELDS)[number];
type RepositoryId = number | string;
type Permission = {
  params?: {
    filter?: unknown;
    fields?: unknown;
    whitelist?: unknown;
    except?: unknown;
    blacklist?: unknown;
  };
} | null;
type Scope = { unrestricted: boolean; ids: RepositoryId[] };
type Access = { scope: Scope; fields: RepositoryField[] } | null;
type GitContextChange = {
  oldPath?: string;
  newPath?: string;
  status?: string;
  newFile: boolean;
  deletedFile: boolean;
  renamedFile: boolean;
  diff?: string;
};

const ACTIONS: Record<Kind, string[]> = {
  repository: [],
  'merge-request': ['mergeRequests', 'mergeRequestDetail'],
  commit: ['branches', 'log', 'commitDetail', 'diff'],
};

function rolesFor(ctx: Context): string[] {
  const roles: unknown = ctx.state?.currentRoles;
  if (!ctx.state?.currentUser?.id || !Array.isArray(roles) || roles.some((role) => typeof role !== 'string')) {
    return ctx.throw(403, 'Permission denied');
  }
  return roles;
}

function allowedField(permission: Permission, field: string): boolean {
  if (!permission) return false;
  const params = permission.params || {};
  for (const key of ['fields', 'whitelist'] as const) {
    const value = params[key];
    if (value !== undefined && !Array.isArray(value)) return false;
    if (Array.isArray(value) && value.length && !value.includes(field) && !value.includes('*')) return false;
  }
  for (const key of ['except', 'blacklist'] as const) {
    const value = params[key];
    if (value !== undefined && !Array.isArray(value)) return false;
    if (Array.isArray(value) && (value.includes(field) || value.includes('*'))) return false;
  }
  return true;
}

function intersectScopes(scopes: Scope[]): Scope {
  const restricted = scopes.filter((scope) => !scope.unrestricted);
  if (!restricted.length) return { unrestricted: true, ids: [] };
  const [first, ...rest] = restricted;
  return {
    unrestricted: false,
    ids: first.ids.filter((id) => rest.every((scope) => scope.ids.some((other) => String(other) === String(id)))),
  };
}

async function permissionsFor(ctx: Context, roles: string[]) {
  if (roles.includes('root')) {
    return new Map<string, Permission>(
      [
        'gitRepositories:list',
        'gitRepositories:get',
        ...Object.values(ACTIONS)
          .flat()
          .map((name) => `gitManager:${name}`),
      ].map((action) => [action, { params: {} }]),
    );
  }
  const pairs: Array<[string, string]> = [
    ['gitRepositories', 'list'],
    ['gitRepositories', 'get'],
    ...Array.from(new Set(Object.values(ACTIONS).flat())).map((name): [string, string] => ['gitManager', name]),
  ];
  const values = await Promise.all(
    pairs.map(
      async ([resource, action]) =>
        [`${resource}:${action}`, (await ctx.app.acl.can({ roles, resource, action })) as Permission] as const,
    ),
  );
  return new Map<string, Permission>(values);
}

function accessFor(permissions: Map<string, Permission>, kind: Kind): Access {
  const list = permissions.get('gitRepositories:list') || null;
  const get = permissions.get('gitRepositories:get') || null;
  const required = [list, get, ...ACTIONS[kind].map((action) => permissions.get(`gitManager:${action}`) || null)];
  if (required.some((permission) => !permission)) return null;
  const scopes = required.map((permission) => resolveRepositoryScope(permission?.params?.filter));
  if (scopes.some((scope) => !scope.supported)) return null;
  const scope = intersectScopes(scopes);
  if (!scope.unrestricted && !scope.ids.length) return null;
  const fields = REPOSITORY_FIELDS.filter((field) => allowedField(list, field) && allowedField(get, field));
  if (!fields.includes('id')) return null;
  return { scope, fields };
}

function scopeFilter(scope: Scope): Filter {
  return scope.unrestricted ? {} : { id: { $in: scope.ids } };
}

function readRepositoryValue(record: unknown, field: string): unknown {
  if (!record || typeof record !== 'object') return undefined;
  const value = record as { get?: (key: string) => unknown } & Record<string, unknown>;
  return typeof value.get === 'function' ? value.get(field) : value[field];
}

function repositorySummary(record: unknown, fields: RepositoryField[]) {
  return Object.fromEntries(fields.map((field) => [field, readRepositoryValue(record, field)]));
}

function kindFrom(value: unknown): Kind | undefined {
  return typeof value === 'string' && KINDS.includes(value as Kind) ? (value as Kind) : undefined;
}

function positiveInteger(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

export async function chatContextOptions(ctx: Context, next: () => Promise<void>) {
  const roles = rolesFor(ctx);
  const params = getEffectiveActionParams(ctx);
  const kind = kindFrom(params.kind);
  if (params.kind !== undefined && !kind) ctx.throw(400, 'Invalid chat context type');
  const permissions = await permissionsFor(ctx, roles);
  const accesses = Object.fromEntries(KINDS.map((name) => [name, accessFor(permissions, name)])) as Record<
    Kind,
    Access
  >;
  const repo = ctx.db.getRepository('gitRepositories');
  const capabilityValues = await Promise.all(
    KINDS.map(async (name) => {
      const access = accesses[name];
      return Boolean(access && (await repo.findOne({ filter: scopeFilter(access.scope), fields: ['id'] })));
    }),
  );
  const capabilities = Object.fromEntries(KINDS.map((name, index) => [name, capabilityValues[index]])) as Record<
    Kind,
    boolean
  >;
  const page = positiveInteger(params.page, 1, 100000);
  const pageSize = positiveInteger(params.pageSize, 20, 100);
  const access = kind ? accesses[kind] : null;
  const search = typeof params.search === 'string' ? params.search.trim().slice(0, 200) : '';
  const repositoryId = params.repositoryId;
  if (
    repositoryId !== undefined &&
    ((typeof repositoryId !== 'string' && typeof repositoryId !== 'number') || !String(repositoryId).trim())
  ) {
    ctx.throw(400, 'Invalid repository');
  }
  let records: unknown[] = [];
  if (access && (!search || access.fields.includes('name'))) {
    const conditions: Filter[] = [scopeFilter(access.scope)];
    if (search) conditions.push({ name: { $includes: search } });
    if (typeof repositoryId === 'string' || typeof repositoryId === 'number') conditions.push({ id: repositoryId });
    const filter = conditions.length === 1 ? conditions[0] : { $and: conditions };
    records = await repo.find({
      filter,
      fields: access.fields,
      sort: ['id'],
      limit: pageSize + 1,
      offset: (page - 1) * pageSize,
    });
  }
  ctx.body = {
    success: true,
    data: {
      capabilities,
      items: records.slice(0, pageSize).map((record) => repositorySummary(record, access?.fields || [])),
      page,
      pageSize,
      hasMore: records.length > pageSize,
    },
  };
  await next();
}

function boundedDiff(value: string, limit: number): { value: string; truncated: boolean; bytes: number } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= limit) return { value, truncated: false, bytes: bytes.length };
  const text = bytes
    .subarray(0, limit)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
  return { value: text, truncated: true, bytes: Buffer.byteLength(text, 'utf8') };
}

export async function loadChatContext(ctx: Context, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const roles = rolesFor(ctx);
  const kind = kindFrom(params.kind);
  const repositoryId = params.repositoryId;
  if (!kind || (typeof repositoryId !== 'number' && typeof repositoryId !== 'string') || !String(repositoryId).trim()) {
    return ctx.throw(400, 'Invalid chat context');
  }
  const access = accessFor(await permissionsFor(ctx, roles), kind);
  if (
    !access ||
    (!access.scope.unrestricted && !scopeIncludesRepository({ id: { $in: access.scope.ids } }, repositoryId))
  ) {
    return ctx.throw(403, 'Permission denied');
  }
  const repository = await ctx.db.getRepository('gitRepositories').findOne({
    filter: { $and: [scopeFilter(access.scope), { id: repositoryId }] },
    fields: access.fields,
  });
  if (!repository) return ctx.throw(404, 'Repository not found');
  const summary = repositorySummary(repository, access.fields);
  const repositoryName = summary.name;
  let content: Record<string, unknown>;
  if (kind === 'repository') {
    content = {
      type: 'git-repository',
      repositoryId,
      name: summary.name,
      defaultBranch: summary.defaultBranch,
      status: summary.status,
    };
  } else if (kind === 'commit') {
    const commitHash = typeof params.commitHash === 'string' ? params.commitHash : '';
    const commit = await readChatCommit(ctx, commitHash, MAX_FILES, MAX_DIFF_BYTES, repositoryId);
    content = {
      type: 'git-commit',
      repositoryId,
      repositoryName,
      ...commit,
      hash: commit.commitSha,
      files: commit.files.map((file) => ({ ...file, file: file.newPath })),
      limitations: commit.limitations.map((limitation) => ctx.t(limitation, { ns: 'plugin-git-manager' })),
    };
  } else {
    const mrIid = Number(params.mrIid);
    if (!Number.isSafeInteger(mrIid) || mrIid <= 0) return ctx.throw(400, 'Invalid merge request');
    const result = await readChatMergeRequest(ctx, mrIid, repositoryId);
    let remaining = MAX_DIFF_BYTES;
    let truncated = result.files.length > MAX_FILES;
    const changes: GitContextChange[] = result.files
      .slice(0, MAX_FILES)
      .map((file: { oldPath?: string; newPath?: string; status?: string; diff?: string; unavailable?: boolean }) => {
        const diff = typeof file.diff === 'string' && !file.unavailable ? boundedDiff(file.diff, remaining) : undefined;
        if (diff) {
          remaining -= diff.bytes;
          truncated ||= diff.truncated;
        }
        return {
          oldPath: file.oldPath,
          newPath: file.newPath,
          status: file.status,
          newFile: file.status === 'added',
          deletedFile: file.status === 'removed',
          renamedFile: file.status === 'renamed',
          diff: diff?.value,
        };
      });
    const limitations = [...result.limitations];
    if (truncated) limitations.push('Additional changed files or diff content were omitted.');
    if (limitations.length) truncated = true;
    content = {
      type: 'git-merge-request',
      repositoryId,
      repositoryName,
      mrIid,
      title: result.title,
      description: result.description,
      state: result.state,
      sourceBranch: result.sourceBranch,
      targetBranch: result.targetBranch,
      author: result.author,
      files: changes.map(({ diff: _diff, ...file }) => file),
      changes,
      truncated,
      limitations: limitations.map((limitation) => ctx.t(limitation, { ns: 'plugin-git-manager' })),
    };
  }
  return content;
}

export async function chatContextContent(ctx: Context, next: () => Promise<void>) {
  const content = await loadChatContext(ctx, getEffectiveActionParams(ctx));
  ctx.body = { success: true, data: content };
  await next();
}
