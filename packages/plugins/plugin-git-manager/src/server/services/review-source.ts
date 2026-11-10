/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'crypto';
import type { Database } from '@nocobase/database';
import { createGit, validateBranch, validateLocalPath, validateRef } from '../actions/git-actions';
import { getRepoAccount } from '../utils/get-repo-account';
import { parseGitLabProject } from '../utils/gitlab-url';

type RecordGetter = { get(name: string): unknown };
type ObjectValue = Record<string, unknown>;

export type ReviewTarget = 'mr' | 'commit' | 'branch' | 'folder';

export interface PinnedReviewSource {
  projectKey: string;
  repositoryId: number;
  targetType: ReviewTarget;
  mrIid: number | null;
  branch: string | null;
  folderPath: string | null;
  headSha: string;
  baseSha: string | null;
}

function object(value: unknown): ObjectValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function sha(value: unknown): string {
  const result = text(value)?.toLowerCase();
  if (!result || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result)) {
    throw new Error('Unable to resolve an immutable Git commit');
  }
  return result;
}

async function responseJson(url: string, headers: Record<string, string>): Promise<ObjectValue> {
  const response = await fetch(url, { headers, redirect: 'error' });
  if (!response.ok) throw new Error(`Git provider request failed (${response.status})`);
  const size = Number(response.headers.get('content-length') || 0);
  if (size > 4_000_000) throw new Error('Git provider response is too large');
  const body = await response.text();
  if (Buffer.byteLength(body) > 4_000_000) throw new Error('Git provider response is too large');
  return object(JSON.parse(body));
}

async function provider(db: Database, repo: RecordGetter) {
  const repoUrl = String(repo.get('repoUrl') || '');
  const account = await getRepoAccount(db, repo);
  const parsed = parseGitLabProject(repoUrl);
  const isGitHub = new URL(repoUrl).hostname.toLowerCase() === 'github.com';
  if (account?.provider === 'github' && !isGitHub) throw new Error('Unsupported GitHub origin');
  if (!isGitHub && !account?.pat) throw new Error('GitLab account is required');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (account?.pat)
    headers[isGitHub ? 'Authorization' : 'PRIVATE-TOKEN'] = isGitHub ? `Bearer ${account.pat}` : account.pat;
  const root = isGitHub
    ? `https://api.github.com/repos/${parsed.projectPath}`
    : `${parsed.apiBase}/projects/${parsed.encodedProject}`;
  const project = await responseJson(root, headers);
  const projectId = project.id;
  const canonical = text(isGitHub ? project.html_url : project.web_url);
  if ((typeof projectId !== 'number' && typeof projectId !== 'string') || !canonical) {
    throw new Error('Git provider did not return a canonical project identity');
  }
  const canonicalUrl = new URL(canonical);
  if (canonicalUrl.protocol !== 'https:' || canonicalUrl.username || canonicalUrl.password) {
    throw new Error('Invalid canonical project origin');
  }
  const identity = `${isGitHub ? 'github' : 'gitlab'}:${canonicalUrl.origin.toLowerCase()}:${projectId}`;
  return {
    root,
    headers,
    isGitHub,
    userApi: isGitHub ? 'https://api.github.com/user' : `${parsed.apiBase}/user`,
    projectKey: createHash('sha256').update(identity).digest('hex'),
    pat: account?.pat || '',
  };
}

export async function resolveReviewProjectKey(db: Database, repo: RecordGetter): Promise<string> {
  return (await provider(db, repo)).projectKey;
}

async function validateCheckoutProject(db: Database, repo: RecordGetter, expectedProjectKey: string): Promise<void> {
  const git = createGit(validateLocalPath(String(repo.get('localPath') || '')));
  let origin: string;
  try {
    origin = (await git.raw(['remote', 'get-url', 'origin'])).trim();
    const remote = new URL(origin);
    if (remote.protocol !== 'https:' || remote.username || remote.password) throw new Error('Invalid origin');
  } catch {
    throw new Error('Checkout origin is missing or unsupported');
  }
  const checkout = { get: (name: string) => (name === 'repoUrl' ? origin : repo.get(name)) };
  let projectKey: string;
  try {
    projectKey = (await provider(db, checkout)).projectKey;
  } catch {
    throw new Error('Checkout origin project could not be verified');
  }
  if (projectKey !== expectedProjectKey) throw new Error('Checkout origin does not match the configured project');
}

function safeFolder(value: string): string {
  const folder = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (folder.split('/').some((part) => part === '..' || part === '.') || value.includes('\0')) {
    throw new Error('Invalid folder path');
  }
  return folder;
}

export async function resolveReviewSource(
  db: Database,
  repo: RecordGetter,
  input: {
    targetType: ReviewTarget;
    mrIid?: number | null;
    commitSha?: string | null;
    branch?: string | null;
    folderPath?: string | null;
    headSha?: string | null;
  },
): Promise<PinnedReviewSource> {
  const remote = await provider(db, repo);
  let headSha: string;
  let baseSha: string | null = null;
  let branch = input.branch || null;
  const folderPath = input.targetType === 'folder' ? safeFolder(input.folderPath || '') : null;
  if (input.targetType === 'mr') {
    if (!input.mrIid || !Number.isSafeInteger(input.mrIid) || input.mrIid < 1) throw new Error('Invalid merge request');
    const mr = await responseJson(
      `${remote.root}/${remote.isGitHub ? 'pulls' : 'merge_requests'}/${input.mrIid}`,
      remote.headers,
    );
    headSha = sha(remote.isGitHub ? object(mr.head).sha : mr.sha || object(mr.diff_refs).head_sha);
    baseSha = sha(remote.isGitHub ? object(mr.base).sha : object(mr.diff_refs).base_sha);
    branch = text(remote.isGitHub ? object(mr.head).ref : mr.source_branch);
    if (input.headSha && sha(input.headSha) !== headSha)
      throw new Error('Merge request head changed before review admission');
  } else {
    await validateCheckoutProject(db, repo, remote.projectKey);
    const git = createGit(validateLocalPath(String(repo.get('localPath') || '')));
    const ref = input.headSha || (input.targetType === 'commit' ? input.commitSha : input.branch || 'HEAD');
    if (!ref) throw new Error('Git ref is required');
    validateRef(ref);
    headSha = sha((await git.raw(['rev-parse', '--verify', `${ref}^{commit}`])).trim());
    if (input.targetType === 'branch') {
      const base = validateBranch(String(repo.get('defaultBranch') || 'main'));
      const baseCommit = sha((await git.raw(['rev-parse', '--verify', `${base}^{commit}`])).trim());
      baseSha = sha((await git.raw(['merge-base', baseCommit, headSha])).trim());
    }
  }
  return {
    projectKey: remote.projectKey,
    repositoryId: Number(repo.get('id')),
    targetType: input.targetType,
    mrIid: input.targetType === 'mr' ? input.mrIid || null : null,
    branch,
    folderPath,
    headSha,
    baseSha,
  };
}

export async function readPinnedReviewSource(
  db: Database,
  repo: RecordGetter,
  source: PinnedReviewSource,
): Promise<string> {
  const remote = await provider(db, repo);
  if (remote.projectKey !== source.projectKey) throw new Error('Repository project changed after admission');
  let content = '';
  if (source.targetType === 'mr') {
    const base = sha(source.baseSha);
    const head = sha(source.headSha);
    if (remote.isGitHub) {
      const comparison = await responseJson(`${remote.root}/compare/${base}...${head}?per_page=100`, remote.headers);
      const files = comparison.files;
      if (!Array.isArray(files) || files.length >= 300) throw new Error('GitHub comparison is incomplete');
      content = files
        .map((item) => {
          const file = object(item);
          if (typeof file.filename !== 'string' || typeof file.patch !== 'string')
            throw new Error('GitHub comparison contains an unavailable patch');
          if (/[\r\n]/.test(file.filename)) throw new Error('GitHub comparison has an unsupported filename');
          return `--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch}`;
        })
        .join('\n');
    } else {
      const comparison = await responseJson(
        `${remote.root}/repository/compare?from=${base}&to=${head}`,
        remote.headers,
      );
      if (comparison.compare_timeout || comparison.overflow || !Array.isArray(comparison.diffs)) {
        throw new Error('GitLab comparison is incomplete');
      }
      content = comparison.diffs
        .map((item) => {
          const file = object(item);
          if (file.too_large || file.collapsed || typeof file.diff !== 'string')
            throw new Error('GitLab comparison contains an unavailable patch');
          const oldPath = String(file.old_path || '');
          const newPath = String(file.new_path || '');
          if (/[\r\n]/.test(oldPath + newPath)) throw new Error('GitLab comparison has an unsupported filename');
          return `--- a/${oldPath}\n+++ b/${newPath}\n${file.diff}`;
        })
        .join('\n');
    }
  } else {
    await validateCheckoutProject(db, repo, source.projectKey);
    const git = createGit(validateLocalPath(String(repo.get('localPath') || '')));
    const head = sha(source.headSha);
    if (source.targetType === 'folder') {
      const folder = safeFolder(source.folderPath || '');
      const tree = await git.raw(['ls-tree', '-r', '--name-only', '-z', head, '--', folder || '.']);
      const paths = tree.split('\0').filter(Boolean);
      if (paths.length > 200) throw new Error('Folder contains too many files to review safely');
      for (const path of paths) {
        if (/[\r\n]/.test(path)) throw new Error('Folder contains an unsupported filename');
        const file = await git.raw(['show', `${head}:${path}`]);
        if (file.includes('\0')) throw new Error('Folder contains an unsupported binary file');
        const lines = file.split('\n');
        content += `\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines
          .map((line) => `+${line}`)
          .join('\n')}`;
        if (Buffer.byteLength(content) > 200_000) throw new Error('Review context exceeds the size limit');
      }
    } else if (source.targetType === 'commit') {
      content = await git.raw(['show', '--format=', '--no-ext-diff', '--no-color', head]);
    } else {
      content = await git.raw(['diff', '--no-ext-diff', '--no-color', sha(source.baseSha), head, '--']);
    }
  }
  if (Buffer.byteLength(content) > 200_000) throw new Error('Review context exceeds the size limit');
  return remote.pat ? content.split(remote.pat).join('[REDACTED]') : content;
}

export async function assertCurrentMrHead(db: Database, repo: RecordGetter, source: PinnedReviewSource): Promise<void> {
  const current = await resolveReviewSource(db, repo, { targetType: 'mr', mrIid: source.mrIid });
  if (current.projectKey !== source.projectKey || current.headSha !== source.headSha) {
    throw new Error('Merge request head changed after review');
  }
  if (!source.baseSha || current.baseSha !== source.baseSha) {
    throw new Error('Merge request base changed after review');
  }
}

export async function findPublishedReview(
  db: Database,
  repo: RecordGetter,
  source: PinnedReviewSource,
  markdown: string,
  marker: string,
): Promise<string | null> {
  const result = await findReviewComment(db, repo, source, markdown, marker, false);
  return result?.noteId ?? null;
}

export async function findLegacyPublishedReview(
  db: Database,
  repo: RecordGetter,
  source: PinnedReviewSource,
  markdown: string,
  marker: string,
): Promise<{ kind: 'marked' | 'unmarked'; noteId: string } | null> {
  return findReviewComment(db, repo, source, markdown, marker, true);
}

async function findReviewComment(
  db: Database,
  repo: RecordGetter,
  source: PinnedReviewSource,
  markdown: string,
  marker: string,
  includeUnmarked: boolean,
): Promise<{ kind: 'marked' | 'unmarked'; noteId: string } | null> {
  if (!source.mrIid) throw new Error('Only merge request reviews can be published');
  const remote = await provider(db, repo);
  if (!remote.pat || remote.projectKey !== source.projectKey)
    throw new Error('Repository credentials or project changed');
  const authenticated = await responseJson(remote.userApi, remote.headers);
  if (typeof authenticated.id !== 'number' && typeof authenticated.id !== 'string')
    throw new Error('Unable to verify Git account identity');
  const expectedBody = `${markdown}\n\n${marker}`;
  const url = `${remote.root}/${
    remote.isGitHub ? `issues/${source.mrIid}/comments` : `merge_requests/${source.mrIid}/notes`
  }`;
  let unmarkedNoteId: string | null = null;
  for (let page = 1; page <= 100; page++) {
    const response = await fetch(`${url}?per_page=100&page=${page}`, { headers: remote.headers, redirect: 'error' });
    if (!response.ok) throw new Error(`Unable to check existing review comments (${response.status})`);
    const notes: unknown = await response.json();
    if (!Array.isArray(notes)) throw new Error('Invalid review comment response');
    for (const note of notes.map(object)) {
      if (typeof note.body !== 'string') continue;
      const author = object(remote.isGitHub ? note.user : note.author);
      if (note.body.includes(marker)) {
        if (note.body !== expectedBody || String(author.id) !== String(authenticated.id))
          throw new Error('Review comment marker is ambiguous');
        if (typeof note.id !== 'number' && typeof note.id !== 'string')
          throw new Error('Review comment identifier is unavailable');
        return { kind: 'marked', noteId: String(note.id) };
      }
      if (includeUnmarked && note.body === markdown && String(author.id) === String(authenticated.id)) {
        if (typeof note.id !== 'number' && typeof note.id !== 'string')
          throw new Error('Review comment identifier is unavailable');
        unmarkedNoteId = String(note.id);
      }
    }
    if (notes.length < 100) break;
    if (page === 100) throw new Error('Too many review comments to check safely');
  }
  return unmarkedNoteId ? { kind: 'unmarked', noteId: unmarkedNoteId } : null;
}

export async function publishPinnedReview(
  db: Database,
  repo: RecordGetter,
  source: PinnedReviewSource,
  markdown: string,
  marker: string,
  initiate: (start: () => ReturnType<typeof fetch>) => Promise<{ response: ReturnType<typeof fetch> }>,
): Promise<string> {
  const existing = await findPublishedReview(db, repo, source, markdown, marker);
  if (existing) return existing;
  const remote = await provider(db, repo);
  if (!remote.pat || remote.projectKey !== source.projectKey || !source.mrIid)
    throw new Error('Repository credentials or project changed');
  const url = `${remote.root}/${
    remote.isGitHub ? `issues/${source.mrIid}/comments` : `merge_requests/${source.mrIid}/notes`
  }`;
  await assertCurrentMrHead(db, repo, source);
  const { response: pending } = await initiate(() =>
    fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { ...remote.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: `${markdown}\n\n${marker}` }),
    }),
  );
  const response = await pending;
  if (!response.ok) throw new Error(`Review comment outcome is unknown (${response.status})`);
  const result = object(await response.json());
  if (typeof result.id !== 'number' && typeof result.id !== 'string')
    throw new Error('Review comment outcome is unknown');
  return String(result.id);
}
