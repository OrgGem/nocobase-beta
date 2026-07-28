import { spawn } from 'child_process';
import { existsSync } from 'fs';
import type { Readable } from 'stream';

import type { Database } from '@nocobase/database';

import { getGitBinaryPath, validateLocalPath, validateRef } from '../actions/git-actions';

function positiveLimit(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

// Registry reads are bounded before their buffers can be handed to a provider.
// The defaults stay below the Registry artifact limits and can be tightened per deployment.
export interface RegistryGitContentLimits {
  maxFileBytes: number;
  maxTreeEntries: number;
  maxTreeOutputBytes: number;
}

const DEFAULT_REGISTRY_GIT_CONTENT_LIMITS: RegistryGitContentLimits = Object.freeze({
  maxFileBytes: positiveLimit(process.env.SKILL_REGISTRY_MAX_SOURCE_FILE_BYTES, 10 * 1024 * 1024, 250 * 1024 * 1024),
  maxTreeEntries: positiveLimit(process.env.SKILL_REGISTRY_MAX_SOURCE_TREE_ENTRIES, 5000, 100_000),
  maxTreeOutputBytes: positiveLimit(
    process.env.SKILL_REGISTRY_MAX_SOURCE_TREE_OUTPUT_BYTES,
    4 * 1024 * 1024,
    250 * 1024 * 1024,
  ),
});

export interface RegistryGitTreeEntry {
  type: 'blob' | 'tree';
  path: string;
  size: number;
}

type RepositoryModel = {
  get(attribute: string): unknown;
};

export const REGISTRY_EXPORT_NOT_GRANTED = 'REGISTRY_EXPORT_NOT_GRANTED';
export const REGISTRY_CONTENT_LIMIT_EXCEEDED = 'REGISTRY_CONTENT_LIMIT_EXCEEDED';
export const REGISTRY_GIT_FILE_NOT_FOUND = 'REGISTRY_GIT_FILE_NOT_FOUND';

const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const MAX_STDERR_BYTES = 64 * 1024;

export class RegistryExportNotGrantedError extends Error {
  readonly code = REGISTRY_EXPORT_NOT_GRANTED;

  constructor() {
    super('Registry export is not enabled for this repository.');
    this.name = 'RegistryExportNotGrantedError';
  }
}

export class RegistryContentLimitError extends Error {
  readonly code = REGISTRY_CONTENT_LIMIT_EXCEEDED;

  constructor(message: string) {
    super(message);
    this.name = 'RegistryContentLimitError';
  }
}

export class RegistryGitFileNotFoundError extends Error {
  readonly code = REGISTRY_GIT_FILE_NOT_FOUND;

  constructor() {
    super('Git file was not found at the pinned commit.');
    this.name = 'RegistryGitFileNotFoundError';
  }
}

function boundedPositive(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum ? Number(value) : fallback;
}

function runGitBuffer(localPath: string, args: string[], maximumBytes: number, timeoutMs: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(getGitBinaryPath(), ['-C', localPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let stderr = '';
    let stderrBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new RegistryContentLimitError('Git registry read exceeded its execution timeout.'));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) {
        return;
      }
      outputBytes += chunk.length;
      if (outputBytes > maximumBytes) {
        fail(new RegistryContentLimitError('Git registry read exceeded its output limit.'));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_STDERR_BYTES) {
        return;
      }
      const remaining = MAX_STDERR_BYTES - stderrBytes;
      const bounded = chunk.subarray(0, remaining);
      stderrBytes += bounded.length;
      stderr += bounded.toString('utf8');
    });
    child.once('error', (error) => fail(error));
    child.once('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        if (/does not exist in|exists on disk, but not in|path .* does not exist/i.test(stderr)) {
          reject(new RegistryGitFileNotFoundError());
          return;
        }
        reject(new Error(`git command failed: ${stderr.trim() || String(code)}`));
        return;
      }
      resolve(Buffer.concat(chunks, outputBytes));
    });
  });
}

function normalizeRootPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized) {
    return '';
  }
  if (normalized.includes('\0') || normalized.split('/').some((part) => part === '.' || part === '..' || part === '')) {
    throw new Error('Invalid repository path');
  }
  return normalized;
}

function normalizeFilePath(value: string): string {
  const normalized = normalizeRootPath(value);
  if (!normalized) {
    throw new Error('File path is required');
  }
  return normalized;
}

function repositoryValue(repository: RepositoryModel, field: string): string {
  const value = repository.get(field);
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function parseTreeLine(line: string, rootPath: string): RegistryGitTreeEntry | null {
  const match = line.match(/^(\d+)\s+(blob|tree)\s+([a-f0-9]+)\s+(-|\d+)\t(.+)$/);
  if (!match) {
    return null;
  }
  const candidatePath = match[5].replace(/\\/g, '/');
  const prefix = rootPath ? `${rootPath}/` : '';
  const path = candidatePath.startsWith(prefix) ? candidatePath.slice(prefix.length) : candidatePath;
  return {
    type: match[2] as 'blob' | 'tree',
    path: normalizeRootPath(path),
    size: match[4] === '-' ? 0 : Number.parseInt(match[4], 10),
  };
}

export class RegistryGitContentService {
  constructor(
    private readonly database: Database,
    private readonly limits: RegistryGitContentLimits = DEFAULT_REGISTRY_GIT_CONTENT_LIMITS,
  ) {}

  async resolveCommit(repositoryId: string | number, ref: string): Promise<string> {
    const repository = await this.findRepository(repositoryId);
    const localPath = validateLocalPath(repositoryValue(repository, 'localPath'));
    if (!existsSync(localPath)) {
      throw new Error('Repository directory does not exist. Clone the repository before reading its content.');
    }
    const result = (
      await runGitBuffer(
        localPath,
        ['rev-parse', '--verify', `${validateRef(ref)}^{commit}`],
        256,
        DEFAULT_GIT_TIMEOUT_MS,
      )
    )
      .toString('utf8')
      .trim();
    if (!/^[a-f0-9]{40,64}$/i.test(result)) {
      throw new Error('Git reference did not resolve to a commit SHA');
    }
    return result.toLowerCase();
  }

  async listTree(input: {
    repositoryId: string | number;
    commitSha: string;
    rootPath: string;
    recursive: boolean;
  }): Promise<RegistryGitTreeEntry[]> {
    const repository = await this.findRepository(input.repositoryId);
    const localPath = validateLocalPath(repositoryValue(repository, 'localPath'));
    if (!existsSync(localPath)) {
      throw new Error('Repository directory does not exist. Clone the repository before reading its content.');
    }
    const commitSha = this.assertCommitSha(input.commitSha);
    const rootPath = normalizeRootPath(input.rootPath);
    const target = rootPath ? `${commitSha}:${rootPath}` : commitSha;
    const output = await runGitBuffer(
      localPath,
      ['ls-tree', '-l', ...(input.recursive ? ['-r'] : []), target],
      this.limits.maxTreeOutputBytes,
      DEFAULT_GIT_TIMEOUT_MS,
    );
    const lines = output.toString('utf8').trim().split('\n').filter(Boolean);
    if (lines.length > this.limits.maxTreeEntries) {
      throw new RegistryContentLimitError('Git tree contains too many entries for registry export.');
    }
    return lines
      .map((line) => parseTreeLine(line, rootPath))
      .filter((entry): entry is RegistryGitTreeEntry => entry !== null)
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async readFile(input: {
    repositoryId: string | number;
    commitSha: string;
    filePath: string;
    maxBytes?: number;
  }): Promise<Buffer> {
    const repository = await this.findRepository(input.repositoryId);
    const localPath = validateLocalPath(repositoryValue(repository, 'localPath'));
    if (!existsSync(localPath)) {
      throw new Error('Repository directory does not exist. Clone the repository before reading its content.');
    }
    const commitSha = this.assertCommitSha(input.commitSha);
    const filePath = normalizeFilePath(input.filePath);
    const maximumBytes = boundedPositive(input.maxBytes, this.limits.maxFileBytes, this.limits.maxFileBytes);
    try {
      return await runGitBuffer(localPath, ['show', `${commitSha}:${filePath}`], maximumBytes, DEFAULT_GIT_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof RegistryContentLimitError && error.message.includes('output limit')) {
        throw new RegistryContentLimitError('Git file exceeds the registry source-file limit.');
      }
      throw error;
    }
  }

  async archiveTree(input: { repositoryId: string | number; commitSha: string; rootPath: string }): Promise<Readable> {
    const repository = await this.findRepository(input.repositoryId);
    const localPath = validateLocalPath(repositoryValue(repository, 'localPath'));
    if (!existsSync(localPath)) {
      throw new Error('Repository directory does not exist. Clone the repository before reading its content.');
    }
    const commitSha = this.assertCommitSha(input.commitSha);
    const rootPath = normalizeRootPath(input.rootPath);
    return new Promise<Readable>((resolve, reject) => {
      const child = spawn(
        getGitBinaryPath(),
        ['-C', localPath, 'archive', '--format=zip', commitSha, ...(rootPath ? [rootPath] : [])],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        if (Buffer.byteLength(stderr, 'utf8') >= MAX_STDERR_BYTES) {
          return;
        }
        stderr += chunk.toString('utf8').slice(0, MAX_STDERR_BYTES - Buffer.byteLength(stderr, 'utf8'));
      });
      child.once('error', reject);
      child.once('spawn', () => resolve(child.stdout));
      child.once('close', (code) => {
        if (code !== 0) {
          child.stdout.destroy(new Error(`git archive failed: ${stderr.trim() || String(code)}`));
        }
      });
    });
  }

  private async findRepository(repositoryId: string | number): Promise<RepositoryModel> {
    const repository = await this.database.getRepository('gitRepositories').findOne({ filterByTk: repositoryId });
    if (!repository) {
      // Do not distinguish a missing repository from one that exists but has not
      // granted registry export. Callers cannot use this bridge to enumerate
      // repository IDs or infer private repository existence.
      throw new RegistryExportNotGrantedError();
    }
    const repositoryModel = repository as unknown as RepositoryModel;
    if (repositoryModel.get('registryExportEnabled') !== true) {
      throw new RegistryExportNotGrantedError();
    }
    return repositoryModel;
  }

  private assertCommitSha(value: string): string {
    const normalized = validateRef(value);
    if (!/^[a-f0-9]{40,64}$/i.test(normalized)) {
      throw new Error('Registry reads require a full commit SHA');
    }
    return normalized.toLowerCase();
  }
}
