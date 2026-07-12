import { spawn } from 'child_process';
import { existsSync, promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import type { FileSearchSettings } from '../types';

type ProcessResult = {
  stdout: string;
  stderr: string;
};

type RunnerPayload = Record<string, unknown>;

export class PageIndexRunnerService {
  constructor(private readonly app: any) {}

  async healthCheck(settings: FileSearchSettings, env: NodeJS.ProcessEnv = {}) {
    try {
      await this.runProcess(
        settings.pageIndexPythonCommand,
        ['-c', 'from pageindex import PageIndexClient; print("ok")'],
        {
          timeoutMs: 30_000,
          env,
        },
      );
      return { ok: true, message: 'PageIndex is available.' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async indexFile(settings: FileSearchSettings, filePath: string, mode: 'pdf' | 'md', env: NodeJS.ProcessEnv = {}) {
    return this.runJson<{ doc_id: string; document?: unknown }>(
      settings,
      'index',
      {
        workspace: this.resolveWorkspace(settings.pageIndexWorkspace),
        file_path: filePath,
        mode,
        model: settings.indexModel,
        retrieve_model: settings.retrieveModel || settings.indexModel,
      },
      env,
    );
  }

  async search(
    settings: FileSearchSettings,
    docIds: string[],
    query: string,
    limit: number,
    env: NodeJS.ProcessEnv = {},
  ) {
    return this.runJson<{
      results: Array<{
        doc_id: string;
        title?: string;
        snippet?: string;
        page?: number;
        node_id?: string;
        score?: number;
      }>;
    }>(
      settings,
      'search',
      {
        workspace: this.resolveWorkspace(settings.pageIndexWorkspace),
        doc_ids: docIds,
        query,
        limit,
        retrieve_model: settings.retrieveModel || settings.indexModel,
      },
      env,
    );
  }

  private resolveWorkspace(value: string) {
    return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
  }

  private resolveRunnerPath() {
    const distPath = path.resolve(__dirname, 'runner', 'pageindex_runner.py');
    if (existsSync(distPath)) return distPath;
    return path.resolve(__dirname, '..', '..', 'src', 'server', 'runner', 'pageindex_runner.py');
  }

  private async runJson<T>(
    settings: FileSearchSettings,
    action: 'index' | 'search',
    payload: RunnerPayload,
    env: NodeJS.ProcessEnv,
  ): Promise<T> {
    const payloadPath = path.join(
      os.tmpdir(),
      `nocobase-file-search-${Date.now()}-${randomBytes(6).toString('hex')}.json`,
    );
    await fsp.writeFile(payloadPath, JSON.stringify(payload), 'utf8');
    try {
      const result = await this.runProcess(
        settings.pageIndexPythonCommand,
        [this.resolveRunnerPath(), action, '--payload', payloadPath],
        {
          timeoutMs: settings.timeoutMs,
          env,
        },
      );
      return JSON.parse(result.stdout) as T;
    } catch (error) {
      this.app.log?.error?.('[plugin-file-search] PageIndex runner failed', error);
      throw error;
    } finally {
      fsp.unlink(payloadPath).catch(() => undefined);
    }
  }

  private runProcess(
    command: string,
    args: string[],
    options: { timeoutMs: number; env?: NodeJS.ProcessEnv },
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      let timedOut = false;

      const child = spawn(command, args, {
        env: { ...process.env, ...(options.env || {}) },
        shell: process.platform === 'win32',
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs);

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)));
      child.on('error', (error) => settle(() => reject(error)));
      child.on('close', (code, signal) => {
        const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        if (timedOut) {
          settle(() => reject(new Error(`PageIndex runner timed out after ${options.timeoutMs}ms.`)));
          return;
        }
        if (code !== 0) {
          settle(() => reject(new Error(stderr || `PageIndex runner exited with ${signal || code}`)));
          return;
        }
        settle(() => resolve({ stdout, stderr }));
      });
    });
  }
}
