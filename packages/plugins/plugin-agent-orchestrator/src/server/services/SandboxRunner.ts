import { spawn } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import { resolve, delimiter } from 'path';
import { tmpdir } from 'os';
import { FileManager, OutputFileInfo } from './FileManager';
import { CodeValidator } from './CodeValidator';
import {
  ensureSandboxCapabilities,
  getPythonGuardDir,
  SandboxCapabilities,
  SandboxIdentity,
  SandboxNetworkMode,
} from './sandboxCapabilities';

const IS_WINDOWS = process.platform === 'win32';

/** stdout/stderr accumulation cap — matches the old exec() maxBuffer. */
const MAX_STDIO_BYTES = 10 * 1024 * 1024;

/** Only the head of stdout/stderr is ever returned to callers — don't retain more in memory. */
const MAX_STDOUT_CHARS = 5000;
const MAX_STDERR_CHARS = 2000;

/** Resolve the python executable name per platform (python3 on *nix, python on Windows). */
function pythonBinary() {
  return process.env.SKILL_HUB_PYTHON_BIN || (IS_WINDOWS ? 'python' : 'python3');
}

export interface ExecuteOptions {
  language: 'node' | 'python';
  code: string;
  execId: string;
  timeoutSeconds?: number;
  maxOutputSizeMb?: number;
  onProgress?: (progress: ProgressUpdate) => void;
  /** AbortSignal — when aborted, the child process is killed */
  signal?: { addEventListener(event: string, listener: () => void): void };
  /** Package whitelist for import validation (from skillWorkerConfigs) */
  packageWhitelist?: string[];
  /** Optional installed/copied skill package root exposed to the runtime as SKILL_DIR. */
  skillDir?: string;
  /** Validated input exposed as a JSON file to avoid source-code interpolation. */
  inputArgs?: Record<string, unknown>;
}

export interface ProgressUpdate {
  percent: number;
  log: string;
}

export interface ExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  files: OutputFileInfo[];
  durationMs: number;
  /** true if execution was canceled by user */
  canceled?: boolean;
  /** true if execution timed out */
  timedOut?: boolean;
}

export interface UlimitOptions {
  language: 'node' | 'python';
  memLimitMb: number;
  timeoutSeconds: number;
  maxOutputSizeMb: number;
  /** Only apply -u when the child runs under the dedicated sandbox uid. */
  includeNproc: boolean;
}

/**
 * Fixed ulimit prefix for the POSIX shell wrapper. Every number is computed
 * server-side and validated as a finite positive integer before interpolation;
 * no per-execution user data ever enters this string.
 */
export function buildUlimitPrefix(options: UlimitOptions): string {
  const parts: string[] = [];
  const add = (flag: string, value: number) => {
    if (!Number.isFinite(value) || value <= 0) return;
    parts.push(`ulimit ${flag} ${Math.floor(value)} 2>/dev/null;`);
  };
  if (options.language === 'python') {
    // RLIMIT_AS would fatally crash modern Node at startup (V8 reserves a
    // multi-GB virtual address space cage); Node memory is bounded by
    // --max-old-space-size instead.
    add('-v', options.memLimitMb * 1024); // KB
  }
  add('-t', options.timeoutSeconds + 5); // CPU-seconds safety net behind the wall-clock kill
  add('-n', Number(process.env.SKILL_HUB_ULIMIT_NOFILE || 256));
  add('-f', Math.ceil((options.maxOutputSizeMb * 1024 * 1024) / 512)); // POSIX 512-byte blocks, single file
  if (options.includeNproc) {
    // RLIMIT_NPROC is per real uid system-wide — only safe on the dedicated sandbox uid.
    add('-u', Number(process.env.SKILL_HUB_ULIMIT_NPROC || 64));
  }
  return parts.join(' ');
}

export interface NodeArgsOptions {
  memLimitMb: number;
  scriptPath: string;
  workDir: string;
  outputDir: string;
  skillDir?: string;
  nodePathEntries: string[];
  capabilities: SandboxCapabilities;
}

export function buildNodeArgs(options: NodeArgsOptions): string[] {
  const args = [`--max-old-space-size=${options.memLimitMb}`];
  const permissionEnabled = process.env.SKILL_HUB_NODE_PERMISSION !== 'false';
  if (permissionEnabled && options.capabilities.nodePermissionFlag) {
    args.push(options.capabilities.nodePermissionFlag);
    const readDirs = new Set(
      [options.workDir, tmpdir(), options.skillDir || '', ...options.nodePathEntries].filter(Boolean),
    );
    for (const dir of readDirs) {
      args.push(`--allow-fs-read=${dir}`);
    }
    for (const dir of new Set([options.workDir, options.outputDir, tmpdir()])) {
      args.push(`--allow-fs-write=${dir}`);
    }
    if (options.capabilities.nodePermissionAllowAddons) {
      args.push('--allow-addons');
    }
  }
  // Independent of the permission model and version-stable — always on.
  args.push('--disallow-code-generation-from-strings');
  args.push(options.scriptPath);
  return args;
}

export interface BwrapArgsOptions {
  workDir: string;
  skillDir?: string;
  sandboxWorkspace: string;
  /** Extra host dirs (global NODE_PATH/PYTHONPATH entries) to expose read-only. */
  extraReadOnlyDirs: string[];
  env: Record<string, string>;
  network: SandboxNetworkMode;
}

export function buildBwrapArgs(options: BwrapArgsOptions): string[] {
  const args = ['--unshare-all', '--die-with-parent', '--new-session'];
  const bound = new Set<string>();
  const roBind = (path: string) => {
    if (!path || bound.has(path) || !existsSync(path)) return;
    bound.add(path);
    args.push('--ro-bind', path, path);
  };
  // /bin and /lib are usually merged-usr symlinks on Debian; binding them
  // explicitly keeps /bin/sh resolvable inside the mount namespace.
  for (const path of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ssl', '/etc/alternatives']) {
    roBind(path);
  }
  roBind(options.sandboxWorkspace); // node_modules, python_packages, py-guard
  if (options.skillDir) roBind(options.skillDir);
  for (const dir of options.extraReadOnlyDirs) roBind(dir);
  if (options.network === 'inherit') {
    args.push('--share-net');
    for (const path of ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf']) {
      roBind(path);
    }
  }
  args.push('--bind', options.workDir, options.workDir); // covers workDir/output
  args.push('--tmpfs', tmpdir());
  args.push('--proc', '/proc');
  args.push('--dev', '/dev');
  args.push('--chdir', options.workDir);
  args.push('--clearenv');
  for (const [key, value] of Object.entries(options.env)) {
    args.push('--setenv', key, value);
  }
  return args;
}

export class SandboxRunner {
  private validator = new CodeValidator();

  private sandboxWorkspace: string;

  constructor(
    private fileManager: FileManager,
    private logger: any,
    private storagePath: string,
  ) {
    this.sandboxWorkspace = resolve(storagePath, 'sandbox-workspace');
  }

  async execute(options: ExecuteOptions): Promise<ExecutionResult> {
    const {
      language,
      code,
      execId,
      timeoutSeconds = 60,
      maxOutputSizeMb = 50,
      onProgress,
      signal,
      packageWhitelist,
      skillDir,
      inputArgs,
    } = options;

    // 1. Validate code against forbidden patterns
    this.validator.validate(code, language);

    // 1b. Validate imports against the allowlist (builtins + whitelist).
    // Always runs: an empty whitelist restricts code to built-in modules only,
    // which blocks stdlib-based network exfiltration (urllib/socket/etc.).
    this.validator.validateImports(code, language, packageWhitelist || []);

    // 2. Resolve worker capabilities (memoized after the first execution/boot).
    const capabilities = await ensureSandboxCapabilities(this.logger, this.storagePath);

    // 3. Prepare workspace
    const workDir = this.fileManager.createExecDir(execId);
    const outputDir = this.fileManager.getOutputDir(execId);
    const inputFile = resolve(workDir, 'input.json');
    writeFileSync(inputFile, JSON.stringify(inputArgs || {}, null, 2), 'utf-8');

    const filename = language === 'node' ? 'script.js' : 'script.py';
    const scriptPath = resolve(workDir, filename);
    writeFileSync(scriptPath, code, 'utf-8');

    // 3b. Privilege drop — only when the worker runs as root and the sandbox
    // user resolved at init time. Hand the exec dir to that uid first.
    let identity: SandboxIdentity | null =
      !IS_WINDOWS && process.getuid?.() === 0 && capabilities.privilegeDropAvailable
        ? capabilities.sandboxIdentity
        : null;
    if (identity) {
      try {
        this.fileManager.chownExecDir(execId, identity.uid, identity.gid);
      } catch (error) {
        this.logger.warn(
          `[skill-hub] chown of exec dir failed for ${execId}; running without privilege drop: ${
            (error as Error).message
          }`,
        );
        identity = null;
      }
    }

    onProgress?.({ percent: 20, log: 'Code validated, executing...' });

    // 4. Resolve Node Modules Path using the local sandbox workspace
    const nodePath = resolve(this.sandboxWorkspace, 'node_modules');
    const finalNodePath = process.env.NODE_PATH ? `${nodePath}${delimiter}${process.env.NODE_PATH}` : nodePath;
    const nodePathEntries = finalNodePath.split(delimiter).filter(Boolean);

    // 5. Sanitized environment — only expose what's necessary.
    const pythonGuardDir = getPythonGuardDir(this.storagePath);
    const execEnv: Record<string, string> = {
      PATH: process.env.PATH || '',
      HOME: tmpdir(),
      TMPDIR: tmpdir(),
      OUTPUT_DIR: outputDir,
      LANG: 'en_US.UTF-8',
      // Node.js
      NODE_PATH: finalNodePath,
      // Python — audit-hook guard dir first, then bundled packages (svg_to_pptx etc.)
      PYTHONPATH: [
        capabilities.pythonGuardActive ? pythonGuardDir : '',
        skillDir ? resolve(skillDir, 'scripts') : '',
        resolve(this.sandboxWorkspace, 'python_packages'),
        process.env.PYTHONPATH || '',
      ]
        .filter(Boolean)
        .join(delimiter),
      PYTHONIOENCODING: 'utf-8',
      // Denied bytecode-cache writes are best-effort anyway; skip them entirely.
      PYTHONDONTWRITEBYTECODE: '1',
      // Consumed by the sitecustomize.py guard to scope file writes.
      SKILL_HUB_WRITE_ROOTS: [workDir, outputDir, tmpdir()].join(delimiter),
      SKILL_DIR: skillDir || '',
      SKILL_INPUT_FILE: inputFile,
      // DO NOT pass: DB credentials, API keys, APP_KEY, etc.
    };

    // 6. Build command + args — never interpolate per-execution values into a
    // shell string; scriptPath/workDir travel as argv entries only.
    const memLimitMb = Math.max(64, Number(process.env.SKILL_HUB_MEM_LIMIT_MB || 512));
    const command = language === 'node' ? 'node' : pythonBinary();
    const args =
      language === 'node'
        ? buildNodeArgs({
            memLimitMb,
            scriptPath,
            workDir,
            outputDir,
            skillDir,
            nodePathEntries,
            capabilities,
          })
        : [scriptPath];

    let spawnCommand = command;
    let spawnArgs = args;
    if (!IS_WINDOWS) {
      // Tiny shell wrapper exists only for the ulimit builtins. "$0"/"$@" pass
      // command/args through as argv — nothing user-controlled is parsed as shell.
      const ulimitPrefix = buildUlimitPrefix({
        language,
        memLimitMb,
        timeoutSeconds,
        maxOutputSizeMb,
        includeNproc: identity !== null,
      });
      spawnCommand = '/bin/sh';
      spawnArgs = ['-c', `${ulimitPrefix} exec "$0" "$@"`, command, ...args];

      if (capabilities.isolationLevel === 'bwrap') {
        const extraReadOnlyDirs = [
          ...nodePathEntries.filter((entry) => entry !== nodePath),
          ...(process.env.PYTHONPATH || '').split(delimiter),
        ].filter(Boolean);
        spawnArgs = [
          ...buildBwrapArgs({
            workDir,
            skillDir,
            sandboxWorkspace: this.sandboxWorkspace,
            extraReadOnlyDirs,
            env: execEnv,
            network: capabilities.network,
          }),
          '--',
          spawnCommand,
          ...spawnArgs,
        ];
        spawnCommand = 'bwrap';
      }
    }

    // 7. Execute via spawn (no shell around user data, group-kill support)
    const startTime = Date.now();
    let wasCanceled = false;
    let wasTimedOut = false;
    let outputExceeded = false;

    const processResult = await new Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>((_resolve) => {
      let stdout = '';
      let stderr = '';
      let totalBytes = 0;
      let settled = false;
      let timeoutTimer: NodeJS.Timeout | null = null;
      let forceKillTimer: NodeJS.Timeout | null = null;

      const child = spawn(spawnCommand, spawnArgs, {
        cwd: workDir,
        env: execEnv,
        // Process-group leader on POSIX so kill(-pid) reaches every descendant.
        detached: !IS_WINDOWS,
        stdio: ['ignore', 'pipe', 'pipe'],
        uid: identity?.uid,
        gid: identity?.gid,
      });

      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        _resolve({
          exitCode,
          stdout: stdout.slice(0, MAX_STDOUT_CHARS),
          stderr: stderr.slice(0, MAX_STDERR_CHARS),
        });
      };

      const killTree = (killSignal: 'SIGTERM' | 'SIGKILL') => {
        if (!child.pid) return;
        if (IS_WINDOWS) {
          // Best-effort whole-tree kill on Windows (dev-only platform).
          try {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
          } catch {
            child.kill(killSignal);
          }
          return;
        }
        try {
          process.kill(-child.pid, killSignal);
        } catch {
          // ESRCH: group already gone. Fall back to the direct child just in case.
          try {
            child.kill(killSignal);
          } catch {
            // already exited
          }
        }
      };

      const terminate = (reason: string) => {
        this.logger.info(`[skill-hub] Killing process tree for exec ${execId} (${reason})`);
        killTree('SIGTERM');
        if (!forceKillTimer) {
          // Same 3-second grace window as before, applied to the whole group.
          forceKillTimer = setTimeout(() => killTree('SIGKILL'), 3000);
        }
      };

      timeoutTimer = setTimeout(() => {
        wasTimedOut = true;
        terminate('timeout');
      }, timeoutSeconds * 1000);

      const onData = (isStdout: boolean) => (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_STDIO_BYTES) {
          if (!outputExceeded) {
            outputExceeded = true;
            terminate('output exceeded limit');
          }
          return;
        }
        // Retain only the head that finish() returns; totalBytes keeps counting
        // so the runaway-output kill above still triggers.
        if (isStdout) {
          if (stdout.length < MAX_STDOUT_CHARS) stdout += chunk.toString();
        } else if (stderr.length < MAX_STDERR_CHARS) {
          stderr += chunk.toString();
        }
      };
      child.stdout?.on('data', onData(true));
      child.stderr?.on('data', onData(false));

      child.on('error', (error: NodeJS.ErrnoException) => {
        // Spawn-time failures (missing binary, EPERM on uid/gid, ...)
        stderr = `Failed to start sandbox process: ${error.message}\n${stderr}`;
        finish(1);
      });

      child.on('close', (exitCode, exitSignal) => {
        finish(exitSignal !== null || exitCode === null ? -1 : exitCode);
      });

      if (signal) {
        signal.addEventListener('abort', () => {
          wasCanceled = true;
          terminate('user abort');
        });
      }
    });

    const durationMs = Date.now() - startTime;

    onProgress?.({ percent: 80, log: wasCanceled ? 'Canceled' : 'Execution completed, collecting files...' });

    // 8. Collect output files
    const files = this.fileManager.listOutputFiles(execId);

    // 9. Check output size limit
    const totalSizeBytes = this.fileManager.getTotalOutputSize(execId);
    const maxBytes = maxOutputSizeMb * 1024 * 1024;
    if (totalSizeBytes > maxBytes) {
      this.logger.warn(
        `[skill-hub] Execution ${execId}: output size ${totalSizeBytes} bytes exceeds limit ${maxBytes}`,
      );
    }

    onProgress?.({ percent: 100, log: 'Done' });

    const timedOut = wasTimedOut && !wasCanceled;
    if (timedOut) {
      processResult.stderr = `Execution timed out after ${timeoutSeconds}s\n${processResult.stderr}`;
    }

    if (outputExceeded) {
      processResult.stderr = `Execution stdout/stderr exceeded ${Math.floor(MAX_STDIO_BYTES / 1024 / 1024)}MB limit\n${
        processResult.stderr
      }`;
    }

    if (wasCanceled) {
      processResult.stderr = `Execution canceled by user\n${processResult.stderr}`;
    }

    return {
      success: !wasCanceled && !timedOut && !outputExceeded && processResult.exitCode === 0,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      files,
      durationMs,
      canceled: wasCanceled,
      timedOut,
    };
  }
}
