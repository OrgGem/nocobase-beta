import { spawn } from 'child_process';
import { chmodSync, existsSync, readFileSync, statSync } from 'fs';
import { delimiter, join, resolve } from 'path';

const IS_WINDOWS = process.platform === 'win32';

export interface SandboxLogger {
  info(message: string): void;
  warn(message: string): void;
}

export type NodePermissionModel = 'permission' | 'experimental-permission' | 'unavailable' | 'unknown';
export type BwrapMode = 'unprivileged' | 'setuid' | 'unavailable';
export type SandboxIsolationLevel = 'bwrap' | 'hardened-spawn' | 'minimal';
export type SandboxNetworkMode = 'none' | 'inherit';

export interface SandboxIdentity {
  username: string;
  uid: number;
  gid: number;
}

/**
 * Result of the per-worker sandbox capability detection. Computed once at init
 * (or lazily on the first execution) and read on every execution — never
 * re-probed per execution.
 */
export interface SandboxCapabilities {
  isolationLevel: SandboxIsolationLevel;
  privilegeDropAvailable: boolean;
  sandboxIdentity: SandboxIdentity | null;
  nodePermissionModel: NodePermissionModel;
  /** Confirmed CLI flag name, e.g. '--permission'; null when unavailable. */
  nodePermissionFlag: string | null;
  /** Whether '--allow-addons' is accepted alongside the permission flag. */
  nodePermissionAllowAddons: boolean;
  pythonGuardActive: boolean;
  bwrapMode: BwrapMode;
  network: SandboxNetworkMode;
}

const DEFAULT_CAPABILITIES: SandboxCapabilities = {
  isolationLevel: IS_WINDOWS ? 'minimal' : 'hardened-spawn',
  privilegeDropAvailable: false,
  sandboxIdentity: null,
  nodePermissionModel: 'unknown',
  nodePermissionFlag: null,
  nodePermissionAllowAddons: false,
  pythonGuardActive: false,
  bwrapMode: 'unavailable',
  network: 'none',
};

let current: SandboxCapabilities = { ...DEFAULT_CAPABILITIES };
let detectPromise: Promise<SandboxCapabilities> | null = null;

export function getSandboxCapabilities(): SandboxCapabilities {
  return current;
}

export function setSandboxCapabilities(next: SandboxCapabilities): void {
  current = next;
}

export function getSandboxUsername(): string {
  return process.env.SKILL_HUB_SANDBOX_USER || 'nocobase-sandbox';
}

export function getPythonGuardDir(storagePath: string): string {
  return resolve(storagePath, 'sandbox-workspace', 'py-guard');
}

export interface ProbeResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Node error code (e.g. ENOENT) when the process failed to spawn. */
  errorCode?: string;
}

/**
 * Run a short-lived probe/maintenance command without a shell. Never rejects —
 * spawn failures surface as { code: null, errorCode }.
 */
export function runProbeCommand(
  command: string,
  args: string[],
  timeoutMs = 10000,
  options: { uid?: number; gid?: number } = {},
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((_resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      _resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        uid: options.uid,
        gid: options.gid,
      });
    } catch (error) {
      finish({ code: null, stdout: '', stderr: String((error as Error).message || error), errorCode: 'SPAWN' });
      return;
    }

    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ code: null, stdout, stderr: `${stderr}\n[probe timed out after ${timeoutMs}ms]` });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 4096) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ code: null, stdout, stderr: error.message, errorCode: error.code });
    });
    child.on('close', (code) => {
      finish({ code, stdout, stderr });
    });
  });
}

function resolveBinaryPath(name: string): string | null {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve uid/gid of the dedicated sandbox user by reading /etc/passwd
 * directly (no per-execution subprocess).
 */
export function resolveSandboxIdentity(username: string): SandboxIdentity | null {
  try {
    const passwd = readFileSync('/etc/passwd', 'utf-8');
    for (const line of passwd.split('\n')) {
      const parts = line.split(':');
      if (parts[0] === username && parts.length >= 4) {
        const uid = Number(parts[2]);
        const gid = Number(parts[3]);
        if (Number.isInteger(uid) && uid >= 0 && Number.isInteger(gid) && gid >= 0) {
          return { username, uid, gid };
        }
      }
    }
  } catch {
    // /etc/passwd unreadable — treat as no identity
  }
  return null;
}

async function detectNodePermissionFlag(
  logger: SandboxLogger,
): Promise<{ model: NodePermissionModel; flag: string | null; allowAddons: boolean }> {
  const [majorRaw, minorRaw] = process.versions.node.split('.');
  const major = Number(majorRaw);
  const minor = Number(minorRaw);

  let candidates: string[];
  if (major > 22 || (major === 22 && minor >= 13)) {
    candidates = ['--permission', '--experimental-permission'];
  } else if (major >= 20) {
    candidates = ['--experimental-permission', '--permission'];
  } else {
    logger.info(`[skill-hub] Node ${process.versions.node} has no permission model; skipping that layer`);
    return { model: 'unavailable', flag: null, allowAddons: false };
  }

  for (const flag of candidates) {
    // Smoke-test with --allow-addons first (needed for whitelisted native
    // packages like sharp); fall back to the bare flag on older 20.x lines.
    const withAddons = await runProbeCommand(
      'node',
      [flag, '--allow-fs-read=/', '--allow-addons', '-e', 'process.exit(0)'],
      15000,
    );
    if (withAddons.code === 0) {
      return { model: flag === '--permission' ? 'permission' : 'experimental-permission', flag, allowAddons: true };
    }
    const bare = await runProbeCommand('node', [flag, '--allow-fs-read=/', '-e', 'process.exit(0)'], 15000);
    if (bare.code === 0) {
      return { model: flag === '--permission' ? 'permission' : 'experimental-permission', flag, allowAddons: false };
    }
  }

  logger.warn('[skill-hub] Node permission model flags rejected by the local node binary; layer disabled');
  return { model: 'unavailable', flag: null, allowAddons: false };
}

const BWRAP_SMOKE_ARGS = [
  '--unshare-user',
  '--unshare-pid',
  '--ro-bind',
  '/',
  '/',
  '--dev',
  '/dev',
  '--proc',
  '/proc',
  '--',
  'true',
];

async function detectBwrap(logger: SandboxLogger, identity: SandboxIdentity | null): Promise<BwrapMode> {
  if (process.platform !== 'linux') return 'unavailable';

  const version = await runProbeCommand('bwrap', ['--version'], 5000);
  if (version.errorCode === 'ENOENT') {
    logger.info('[skill-hub] bwrap not installed; using hardened spawn isolation (Layer 1)');
    return 'unavailable';
  }

  // Probe under the same uid/gid the real execution will use, so a root-only
  // userns permission does not produce a false positive.
  const probeIds = identity && process.getuid?.() === 0 ? { uid: identity.uid, gid: identity.gid } : {};
  const unprivileged = await runProbeCommand('bwrap', BWRAP_SMOKE_ARGS, 10000, probeIds);
  if (unprivileged.code === 0) return 'unprivileged';

  if (process.getuid?.() === 0) {
    const bwrapPath = resolveBinaryPath('bwrap');
    if (bwrapPath) {
      try {
        const mode = statSync(bwrapPath).mode;
        if (!(mode & 0o4000)) {
          chmodSync(bwrapPath, (mode & 0o7777) | 0o4000);
        }
        const retried = await runProbeCommand('bwrap', BWRAP_SMOKE_ARGS, 10000, probeIds);
        if (retried.code === 0) return 'setuid';
        logger.warn(
          `[skill-hub] bwrap unusable even with setuid bit — likely unprivileged user namespaces disabled at the host kernel and no-new-privileges set on the container: ${retried.stderr
            .trim()
            .slice(0, 200)}`,
        );
      } catch (error) {
        logger.warn(`[skill-hub] Could not apply setuid fallback to bwrap: ${(error as Error).message}`);
      }
    }
  } else {
    logger.warn(
      `[skill-hub] bwrap installed but namespace creation failed (unprivileged userns disabled?): ${unprivileged.stderr
        .trim()
        .slice(0, 200)}`,
    );
  }
  return 'unavailable';
}

async function detectSandboxCapabilities(logger: SandboxLogger, storagePath: string): Promise<SandboxCapabilities> {
  const network: SandboxNetworkMode = process.env.SKILL_HUB_SANDBOX_NET === 'inherit' ? 'inherit' : 'none';

  const pythonGuardActive =
    process.env.SKILL_HUB_PY_GUARD !== 'false' && existsSync(join(getPythonGuardDir(storagePath), 'sitecustomize.py'));

  let nodePermission: { model: NodePermissionModel; flag: string | null; allowAddons: boolean };
  try {
    nodePermission = await detectNodePermissionFlag(logger);
  } catch (error) {
    logger.warn(`[skill-hub] Node permission model detection failed: ${(error as Error).message}`);
    nodePermission = { model: 'unavailable', flag: null, allowAddons: false };
  }

  let identity: SandboxIdentity | null = null;
  let privilegeDropAvailable = false;
  let bwrapMode: BwrapMode = 'unavailable';

  if (!IS_WINDOWS) {
    identity = resolveSandboxIdentity(getSandboxUsername());
    privilegeDropAvailable = process.getuid?.() === 0 && identity !== null;
    if (!privilegeDropAvailable) {
      logger.warn(
        `[skill-hub] Privilege drop unavailable (root=${
          process.getuid?.() === 0
        }, sandbox user "${getSandboxUsername()}" resolved=${identity !== null}); executions run as the worker user`,
      );
    }
    try {
      bwrapMode = await detectBwrap(logger, privilegeDropAvailable ? identity : null);
    } catch (error) {
      logger.warn(`[skill-hub] bwrap detection failed: ${(error as Error).message}`);
      bwrapMode = 'unavailable';
    }
  }

  const isolationLevel: SandboxIsolationLevel =
    bwrapMode !== 'unavailable' ? 'bwrap' : IS_WINDOWS ? 'minimal' : 'hardened-spawn';

  const capabilities: SandboxCapabilities = {
    isolationLevel,
    privilegeDropAvailable,
    sandboxIdentity: privilegeDropAvailable ? identity : null,
    nodePermissionModel: nodePermission.model,
    nodePermissionFlag: nodePermission.flag,
    nodePermissionAllowAddons: nodePermission.allowAddons,
    pythonGuardActive,
    bwrapMode,
    network,
  };

  logger.info(
    `[skill-hub] Sandbox isolation level: ${capabilities.isolationLevel}` +
      ` (privilege drop: ${capabilities.privilegeDropAvailable ? 'active' : 'off'},` +
      ` node permission model: ${capabilities.nodePermissionModel},` +
      ` python guard: ${capabilities.pythonGuardActive ? 'active' : 'off'},` +
      ` bwrap: ${capabilities.bwrapMode}, network: ${capabilities.network})`,
  );

  return capabilities;
}

/**
 * Lazily detect capabilities once per worker process (memoized). Used by
 * SandboxRunner so the first execution after boot has real capability data
 * without requiring an admin-triggered init.
 */
export function ensureSandboxCapabilities(logger: SandboxLogger, storagePath: string): Promise<SandboxCapabilities> {
  if (!detectPromise) {
    detectPromise = detectSandboxCapabilities(logger, storagePath).then((caps) => {
      current = caps;
      return caps;
    });
  }
  return detectPromise;
}

/** Force a fresh detection run — called from WorkerEnvManager.executeInit(). */
export function refreshSandboxCapabilities(logger: SandboxLogger, storagePath: string): Promise<SandboxCapabilities> {
  detectPromise = detectSandboxCapabilities(logger, storagePath).then((caps) => {
    current = caps;
    return caps;
  });
  return detectPromise;
}
