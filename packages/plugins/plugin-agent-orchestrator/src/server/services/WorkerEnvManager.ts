import Application from '@nocobase/server';
import { Database } from '@nocobase/database';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseJsonText, stringifyJsonText } from '../skill-hub/utils/json-fields';
import { PY_GUARD_SITECUSTOMIZE_SOURCE } from './pythonGuardTemplate';
import {
  getPythonGuardDir,
  getSandboxUsername,
  refreshSandboxCapabilities,
  runProbeCommand,
  SandboxLogger,
} from './sandboxCapabilities';

type WorkerEnvConfig = {
  npmRegistryUrl?: string;
  npmAuthToken?: string;
  pypiIndexUrl?: string;
  pypiTrustedHost?: string;
  aptMirrorUrl?: string;
  aptGpgKeyUrl?: string;
  customPackages?: {
    python?: string[];
    node?: string[];
    apt?: string[];
  };
};

const DEFAULT_WHITELIST: Record<'python' | 'node' | 'apt', string[]> = {
  python: [
    'python-docx',
    'openpyxl',
    'pandas',
    'matplotlib',
    'Pillow',
    'reportlab',
    'jinja2',
    'pyyaml',
    'tabulate',
    'xlsxwriter',
    'python-pptx',
  ],
  node: ['xlsx', 'docx', 'pdfkit', 'csv-parse', 'archiver', 'sharp', 'lodash', 'dayjs'],
  apt: ['python3', 'python3-pip', 'python3-venv'],
};

export class WorkerEnvManager {
  constructor(
    private readonly app: Application,
    private readonly db: Database,
    private readonly storagePath: string,
  ) {}

  async getOrCreateConfig() {
    const repo = (this as any).db.getRepository('skillWorkerConfigs');
    let config = await repo.findOne();
    if (config) return config;

    config = await repo.create({
      values: {
        retentionHours: 24,
        initStatus: 'idle',
        initProgressPercent: 0,
        packageWhitelist: stringifyJsonText(DEFAULT_WHITELIST, DEFAULT_WHITELIST),
        customPackages: stringifyJsonText({ python: [], node: [], apt: [] }, { python: [], node: [], apt: [] }),
      },
    });
    return config;
  }

  async initEnvironment(config: WorkerEnvConfig) {
    const current = await this.getOrCreateConfig();
    await current.update({
      initStatus: 'running',
      initProgressPercent: 0,
      initProgressLog: 'Queued sandbox environment refresh',
      lastInitLog: '',
      customPackages: stringifyJsonText(config.customPackages || { python: [], node: [], apt: [] }, {
        python: [],
        node: [],
        apt: [],
      }),
    });

    await (this as any).app.pubSubManager.publish('skill-hub.init-env', {
      ...config,
      storagePath: this.storagePath,
      queuedAt: new Date().toISOString(),
    });

    return 'Sandbox environment refresh queued on available workers.';
  }

  async executeInit(payload: WorkerEnvConfig) {
    const logger: SandboxLogger = (this as any).app?.logger ?? console;
    const publishProgress = async (percent: number, log: string) => {
      await (this as any).app.pubSubManager.publish('skill-hub.init-env.progress', { percent, log });
    };

    // 1. Resolve whitelist (unchanged logic)
    const customPackages = payload.customPackages || { python: [], node: [], apt: [] };
    const whitelist = {
      python: Array.from(new Set([...(DEFAULT_WHITELIST.python || []), ...(customPackages.python || [])])),
      node: Array.from(new Set([...(DEFAULT_WHITELIST.node || []), ...(customPackages.node || [])])),
      apt: Array.from(new Set([...(DEFAULT_WHITELIST.apt || []), ...(customPackages.apt || [])])),
    };
    await publishProgress(10, 'Resolved sandbox package whitelist');

    // 2. Ensure the dedicated sandbox user exists (Linux + root only)
    const sandboxUserLog = await this.ensureSandboxUser(logger);
    await publishProgress(25, sandboxUserLog);

    // 3. Write/refresh the Python audit-hook guard
    const guardLog = this.writePythonGuard(logger);
    await publishProgress(45, guardLog);

    // 4 + 5. Smoke-test Node permission model + bwrap; cache for SandboxRunner
    const capabilities = await refreshSandboxCapabilities(logger, this.storagePath);
    await publishProgress(60, `Node permission model: ${capabilities.nodePermissionModel}`);
    await publishProgress(
      80,
      capabilities.isolationLevel === 'bwrap'
        ? `bubblewrap namespace sandbox active (${capabilities.bwrapMode})`
        : `Sandbox isolation level: ${capabilities.isolationLevel}`,
    );

    // 6. Done — payload gains the achieved isolation summary
    await (this as any).app.pubSubManager.publish('skill-hub.init-env.done', {
      status: 'succeeded',
      log:
        `Sandbox environment is ready on this worker. Isolation level: ${capabilities.isolationLevel}; ` +
        `privilege drop: ${capabilities.privilegeDropAvailable ? 'active' : 'unavailable'}; ` +
        `Node permission model: ${capabilities.nodePermissionModel}; ` +
        `Python guard: ${capabilities.pythonGuardActive ? 'active' : 'inactive'}; ` +
        `network: ${capabilities.network}. Whitelist was refreshed.`,
      whitelist,
      isolationLevel: capabilities.isolationLevel,
      privilegeDropAvailable: capabilities.privilegeDropAvailable,
      nodePermissionModel: capabilities.nodePermissionModel,
      pythonGuardActive: capabilities.pythonGuardActive,
      network: capabilities.network,
    });
  }

  /**
   * Idempotently create the dedicated sandbox user with no supplementary
   * groups (blunts the libuv setuid-without-setgroups gap). Never throws —
   * failure just leaves privilege drop unavailable.
   */
  private async ensureSandboxUser(logger: SandboxLogger): Promise<string> {
    if (process.platform !== 'linux') {
      return 'Sandbox user skipped (privilege drop is Linux-only)';
    }
    if (process.getuid?.() !== 0) {
      return 'Sandbox user skipped (worker is not running as root)';
    }
    const username = getSandboxUsername();
    try {
      const passwd = readFileSync('/etc/passwd', 'utf-8');
      if (passwd.split('\n').some((line) => line.startsWith(`${username}:`))) {
        return `Sandbox user "${username}" already exists`;
      }
    } catch (error) {
      logger.warn(`[skill-hub] Could not read /etc/passwd: ${(error as Error).message}`);
    }
    const result = await runProbeCommand(
      'useradd',
      ['--system', '--no-create-home', '--shell', '/usr/sbin/nologin', '--no-user-group', username],
      30000,
    );
    if (result.code === 0) {
      return `Created sandbox user "${username}"`;
    }
    const reason = (result.stderr || result.errorCode || `exit ${result.code}`).trim().slice(0, 200);
    logger.warn(`[skill-hub] useradd for "${username}" failed; privilege drop unavailable: ${reason}`);
    return `Sandbox user unavailable (${reason})`;
  }

  /** Write/refresh sitecustomize.py so plugin upgrades propagate guard changes. */
  private writePythonGuard(logger: SandboxLogger): string {
    if (process.env.SKILL_HUB_PY_GUARD === 'false') {
      return 'Python audit-hook guard disabled via SKILL_HUB_PY_GUARD=false';
    }
    try {
      const guardDir = getPythonGuardDir(this.storagePath);
      mkdirSync(guardDir, { recursive: true });
      writeFileSync(join(guardDir, 'sitecustomize.py'), PY_GUARD_SITECUSTOMIZE_SOURCE, 'utf-8');
      return 'Python audit-hook guard (sitecustomize.py) refreshed';
    } catch (error) {
      logger.warn(`[skill-hub] Failed to write python guard: ${(error as Error).message}`);
      return `Python audit-hook guard unavailable (${(error as Error).message})`;
    }
  }

  parsePackageWhitelist(config: any) {
    return parseJsonText(config?.get?.('packageWhitelist') ?? config?.packageWhitelist, DEFAULT_WHITELIST);
  }
}
