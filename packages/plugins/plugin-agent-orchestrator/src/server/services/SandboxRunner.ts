import { exec, ChildProcess, ExecException } from 'child_process';
import { writeFileSync } from 'fs';
import { resolve, delimiter } from 'path';
import { tmpdir } from 'os';
import { FileManager, OutputFileInfo } from './FileManager';
import { CodeValidator } from './CodeValidator';

const IS_WINDOWS = process.platform === 'win32';

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
    } = options;

    // 1. Validate code against forbidden patterns
    this.validator.validate(code, language);

    // 1b. Validate imports against the allowlist (builtins + whitelist).
    // Always runs: an empty whitelist restricts code to built-in modules only,
    // which blocks stdlib-based network exfiltration (urllib/socket/etc.).
    this.validator.validateImports(code, language, packageWhitelist || []);

    // 2. Prepare workspace
    const workDir = this.fileManager.createExecDir(execId);
    const outputDir = this.fileManager.getOutputDir(execId);

    const filename = language === 'node' ? 'script.js' : 'script.py';
    const scriptPath = resolve(workDir, filename);
    writeFileSync(scriptPath, code, 'utf-8');

    onProgress?.({ percent: 20, log: 'Code validated, executing...' });

    // 3. Resolve Node Modules Path using the local sandbox workspace
    const nodePath = resolve(this.sandboxWorkspace, 'node_modules');
    const finalNodePath = process.env.NODE_PATH ? `${nodePath}${delimiter}${process.env.NODE_PATH}` : nodePath;

    // 4. Build command.
    // Memory cap (MB): node gets --max-old-space-size; on Linux/macOS the whole
    // process tree is additionally bounded with `ulimit -v` so a python skill
    // cannot exhaust host memory. Windows has no ulimit equivalent, so the cap
    // there is best-effort (node heap only) — production runs on Linux.
    const memLimitMb = Math.max(64, Number(process.env.SKILL_HUB_MEM_LIMIT_MB || 512));
    const baseCmd =
      language === 'node'
        ? `node --max-old-space-size=${memLimitMb} "${scriptPath}"`
        : `${pythonBinary()} "${scriptPath}"`;
    const cmd = !IS_WINDOWS && memLimitMb > 0 ? `ulimit -v ${memLimitMb * 1024} 2>/dev/null; exec ${baseCmd}` : baseCmd;

    // 5. Execute via child_process with sanitized env
    const startTime = Date.now();
    let childProc: ChildProcess | null = null;
    let wasCanceled = false;

    const processResult = await new Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>((_resolve) => {
      childProc = exec(
        cmd,
        {
          timeout: timeoutSeconds * 1000,
          maxBuffer: 10 * 1024 * 1024, // 10MB stdout/stderr buffer
          cwd: workDir,
          env: {
            // Sanitized environment — only expose what's necessary
            PATH: process.env.PATH,
            HOME: tmpdir(),
            TMPDIR: tmpdir(),
            OUTPUT_DIR: outputDir,
            LANG: 'en_US.UTF-8',
            // Node.js
            NODE_PATH: finalNodePath,
            // Python — include bundled packages (svg_to_pptx etc.)
            PYTHONPATH: [
              skillDir ? resolve(skillDir, 'scripts') : '',
              resolve(this.sandboxWorkspace, 'python_packages'),
              process.env.PYTHONPATH || '',
            ]
              .filter(Boolean)
              .join(delimiter),
            PYTHONIOENCODING: 'utf-8',
            SKILL_DIR: skillDir || '',
            // DO NOT pass: DB credentials, API keys, APP_KEY, etc.
          },
        },
        (error: ExecException | null, stdout: string, stderr: string) => {
          let exitCode = 0;
          if (error) {
            if (error.killed) {
              exitCode = -1; // Killed by timeout or abort
            } else {
              exitCode = error.code || 1;
            }
          }

          _resolve({
            exitCode,
            stdout: (stdout || '').slice(0, 5000),
            stderr: (stderr || '').slice(0, 2000),
          });
        },
      );

      // 5. Wire abort signal → kill child process
      if (signal) {
        signal.addEventListener('abort', () => {
          wasCanceled = true;
          if (childProc && !childProc.killed) {
            this.logger.info(`[skill-hub] Killing child process for exec ${execId} (user abort)`);
            childProc.kill('SIGTERM');
            // Force kill after 3 seconds if SIGTERM didn't work
            setTimeout(() => {
              if (childProc && !childProc.killed) {
                childProc.kill('SIGKILL');
              }
            }, 3000);
          }
        });
      }
    });

    const durationMs = Date.now() - startTime;

    onProgress?.({ percent: 80, log: wasCanceled ? 'Canceled' : 'Execution completed, collecting files...' });

    // 6. Collect output files
    const files = this.fileManager.listOutputFiles(execId);

    // 7. Check output size limit
    const totalSizeBytes = this.fileManager.getTotalOutputSize(execId);
    const maxBytes = maxOutputSizeMb * 1024 * 1024;
    if (totalSizeBytes > maxBytes) {
      this.logger.warn(
        `[skill-hub] Execution ${execId}: output size ${totalSizeBytes} bytes exceeds limit ${maxBytes}`,
      );
    }

    onProgress?.({ percent: 100, log: 'Done' });

    // Detect timeout
    const timedOut = !wasCanceled && processResult.exitCode === -1;
    if (timedOut) {
      processResult.stderr = `Execution timed out after ${timeoutSeconds}s\n${processResult.stderr}`;
    }

    if (wasCanceled) {
      processResult.stderr = `Execution canceled by user\n${processResult.stderr}`;
    }

    return {
      success: !wasCanceled && !timedOut && processResult.exitCode === 0,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      files,
      durationMs,
      canceled: wasCanceled,
      timedOut,
    };
  }
}
