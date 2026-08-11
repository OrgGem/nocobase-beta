import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join, resolve } from 'path';
import { unlink, writeFile } from 'fs/promises';
import type { AttachmentLike } from './internal-parser-registry';
import type { Context } from '@nocobase/actions';

export type MarkItDownRuntimeInfo = {
  command: string;
  baseArgs: string[];
  builtinSourcePath: string;
  builtinRunnerPath: string;
  enablePlugins: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  supportedExtnames: string[];
};

export type MarkItDownCheckResult = MarkItDownRuntimeInfo & {
  available: boolean;
  message: string;
};

const RESERVED_EXTNAMES = new Set(['.pdf', '.xls', '.xlsx']);

const DEFAULT_SUPPORTED_EXTNAMES = [
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.csv',
  '.tsv',
  '.json',
  '.xml',
  '.html',
  '.htm',
  '.txt',
  '.md',
  '.zip',
  '.epub',
  '.msg',
  '.wav',
  '.mp3',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
];

type ProcessResult = {
  stdout: string;
  stderr: string;
};

type ProcessCandidate = {
  label: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

export class MarkItDownService {
  private attachmentBufferFetcher?: (
    ctx: Context,
    attachment: AttachmentLike,
  ) => Promise<{ buffer: Buffer; url: string }>;

  setAttachmentBufferFetcher(
    fetcher: (ctx: Context, attachment: AttachmentLike) => Promise<{ buffer: Buffer; url: string }>,
  ) {
    this.attachmentBufferFetcher = fetcher;
  }

  getRuntimeInfo(): MarkItDownRuntimeInfo {
    const usePythonModule =
      parseBoolean(process.env.MARKITDOWN_USE_PYTHON_MODULE) || !!process.env.MARKITDOWN_PYTHON_BIN;
    const command = usePythonModule
      ? process.env.MARKITDOWN_PYTHON_BIN || 'python'
      : process.env.MARKITDOWN_COMMAND || 'markitdown';

    return {
      command,
      baseArgs: usePythonModule ? ['-m', 'markitdown'] : [],
      builtinSourcePath: getBuiltinSourcePath(),
      builtinRunnerPath: getBuiltinRunnerPath(),
      enablePlugins: parseBoolean(process.env.MARKITDOWN_ENABLE_PLUGINS),
      timeoutMs: parsePositiveInt(process.env.MARKITDOWN_TIMEOUT_MS, 120_000),
      maxOutputBytes: parsePositiveInt(process.env.MARKITDOWN_MAX_OUTPUT_BYTES, 32 * 1024 * 1024),
      supportedExtnames: resolveSupportedExtnames(),
    };
  }

  supports(attachment: AttachmentLike): boolean {
    const ext = resolveExtname(attachment);
    if (RESERVED_EXTNAMES.has(ext)) return false;

    const supportedExtnames = this.getRuntimeInfo().supportedExtnames;
    if (supportedExtnames.length === 0) return true;
    return !!ext && supportedExtnames.includes(ext);
  }

  async checkAvailability(): Promise<MarkItDownCheckResult> {
    const runtime = this.getRuntimeInfo();
    const errors: string[] = [];

    for (const candidate of this.getAvailabilityCandidates()) {
      try {
        await this.runProcess(candidate, 10_000, 1024 * 1024);
        return {
          ...runtime,
          available: true,
          message: `MarkItDown is available via ${candidate.label}.`,
        };
      } catch (err: any) {
        errors.push(`${candidate.label}: ${err?.message || String(err)}`);
      }
    }

    return {
      ...runtime,
      available: false,
      message: errors.join('\n'),
    };
  }

  async convertBuffer(buffer: Buffer, attachment: AttachmentLike = {}): Promise<string> {
    const ext = sanitizeExtname(resolveExtname(attachment)) || '.bin';
    const tempPath = join(tmpdir(), `nocobase-markitdown-${Date.now()}-${randomBytes(6).toString('hex')}${ext}`);

    await writeFile(tempPath, buffer);
    try {
      return await this.convertFile(tempPath);
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
  }

  async parseBuffer(buffer: Buffer, attachment: AttachmentLike = {}): Promise<string> {
    return this.convertBuffer(buffer, attachment);
  }

  async parseAttachment(ctx: Context, attachment: AttachmentLike): Promise<string> {
    if (!this.attachmentBufferFetcher) {
      throw new Error('plugin-document-parser fetchFileBuffer is required to parse attachments.');
    }
    const { buffer } = await this.attachmentBufferFetcher(ctx, attachment);
    return this.convertBuffer(buffer, attachment);
  }

  async convertFile(filePath: string): Promise<string> {
    const runtime = this.getRuntimeInfo();
    const args = [];
    if (runtime.enablePlugins) {
      args.push('--use-plugins');
    }
    args.push(filePath);

    const errors: string[] = [];
    for (const candidate of this.getProcessCandidates(args)) {
      try {
        const result = await this.runProcess(candidate, runtime.timeoutMs, runtime.maxOutputBytes);
        return result.stdout.replace(/\s+$/g, '');
      } catch (err: any) {
        errors.push(`${candidate.label}: ${err?.message || String(err)}`);
      }
    }

    throw new Error(errors.join('\n'));
  }

  private getProcessCandidates(args: string[]): ProcessCandidate[] {
    const runtime = this.getRuntimeInfo();
    const candidates: ProcessCandidate[] = [
      {
        label: runtime.baseArgs.length > 0 ? 'python module' : 'command',
        command: runtime.command,
        args: [...runtime.baseArgs, ...args],
      },
    ];

    const builtinRunnerPath = getBuiltinRunnerPath();
    if (!process.env.MARKITDOWN_COMMAND && existsSync(builtinRunnerPath)) {
      candidates.push({
        label: 'bundled source',
        command: process.env.MARKITDOWN_PYTHON_BIN || 'python',
        args: [builtinRunnerPath, ...args],
        env: withPythonPath(getBuiltinSourcePath()),
      });
    }

    return candidates;
  }

  private getAvailabilityCandidates(): ProcessCandidate[] {
    return this.getProcessCandidates(['--help']).map((candidate) => {
      if (candidate.label !== 'bundled source') return candidate;
      return {
        ...candidate,
        args: [getBuiltinRunnerPath(), '--check'],
      };
    });
  }

  private runProcess(candidate: ProcessCandidate, timeoutMs: number, maxOutputBytes: number): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let outputExceeded = false;
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const child = spawn(candidate.command, candidate.args, {
        env: candidate.env || process.env,
        shell: process.platform === 'win32',
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);

      const collect = (chunks: Buffer[], chunk: Buffer, currentBytes: number): number => {
        const nextBytes = currentBytes + chunk.length;
        if (nextBytes > maxOutputBytes) {
          outputExceeded = true;
          child.kill();
          return nextBytes;
        }
        chunks.push(Buffer.from(chunk));
        return nextBytes;
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes = collect(stdoutChunks, chunk, stdoutBytes);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes = collect(stderrChunks, chunk, stderrBytes);
      });

      child.on('error', (err) => {
        settle(() => reject(err));
      });

      child.on('close', (code, signal) => {
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');

        if (timedOut) {
          settle(() => reject(new Error(`MarkItDown timed out after ${timeoutMs}ms.`)));
          return;
        }

        if (outputExceeded) {
          settle(() => reject(new Error(`MarkItDown output exceeded ${maxOutputBytes} bytes.`)));
          return;
        }

        if (code !== 0) {
          const reason = stderr.trim() || `process exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`;
          settle(() => reject(new Error(`MarkItDown failed: ${reason}`)));
          return;
        }

        settle(() => resolve({ stdout, stderr }));
      });
    });
  }
}

export function resolveExtname(attachment: AttachmentLike): string {
  if (attachment.extname) return normalizeExtname(attachment.extname);
  const name = attachment.filename ?? attachment.name ?? '';
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? normalizeExtname(name.slice(idx)) : '';
}

function resolveSupportedExtnames(): string[] {
  const raw = process.env.MARKITDOWN_EXTENSIONS;
  if (!raw) return DEFAULT_SUPPORTED_EXTNAMES;
  if (raw.trim() === '*') return [];
  return raw
    .split(',')
    .map((item) => normalizeExtname(item.trim()))
    .filter(Boolean);
}

function normalizeExtname(value: string): string {
  if (!value) return '';
  const normalized = value.startsWith('.') ? value.toLowerCase() : `.${value.toLowerCase()}`;
  return sanitizeExtname(normalized);
}

function sanitizeExtname(value: string): string {
  return /^[.][a-z0-9][a-z0-9+-]*$/i.test(value) ? value.toLowerCase() : '';
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getBuiltinSourcePath(): string {
  return resolve(__dirname, '..', '..', '..', 'vendor', 'python');
}

function getBuiltinRunnerPath(): string {
  return join(getBuiltinSourcePath(), 'nocobase_markitdown_runner.py');
}

function withPythonPath(pathValue: string): NodeJS.ProcessEnv {
  const current = process.env.PYTHONPATH;
  return {
    ...process.env,
    PYTHONPATH: current ? `${pathValue}${delimiter}${current}` : pathValue,
  };
}
