import { spawn } from 'child_process';
import { getRedisClient } from '../utils/redis';
import { promises as fsp } from 'fs';
import path from 'path';
import Application from '@nocobase/server';

/** Allow only safe package name characters: letters, digits, dash, underscore, dot, @, /, [, ] */
const SAFE_PKG_RE = /^(?:[a-zA-Z0-9_.@/-]|\[|\])+$/;
const INSTALL_CHANNEL = 'cluster-manager.install-packages';

type TargetRole = 'app' | 'worker' | 'sandbox' | 'all';
type PackageKind = 'apt' | 'npm' | 'python';

interface InstallPayload {
  targetRole: TargetRole;
  packages: { apt?: string[]; npm?: string[]; python?: string[] };
  registryConfig?: { aptMirrorUrl?: string; npmRegistryUrl?: string; pypiIndexUrl?: string; pypiTrustedHost?: string };
}

interface AptOsInfo {
  id: string;
  codename: string;
}

function sanitizePkg(name: string): string {
  if (typeof name !== 'string') {
    throw new Error('Package name must be a string');
  }
  const trimmed = name.trim();
  if (!SAFE_PKG_RE.test(trimmed)) {
    throw new Error(`Unsafe or invalid package name rejected: "${trimmed}"`);
  }
  return trimmed;
}

function sanitizePackageList(packages?: string[]): string[] {
  if (!Array.isArray(packages)) return [];
  return Array.from(new Set(packages.map(sanitizePkg)));
}

function sanitizeHttpUrl(value: unknown, label: string): string | undefined {
  const trimmed = String(value || '').trim();
  if (!trimmed) return undefined;
  if (/\s/.test(trimmed)) {
    throw new Error(`${label} must not contain whitespace`);
  }

  const url = new URL(trimmed);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must use http or https`);
  }
  return url.toString();
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = url.username ? '***' : '';
      url.password = url.password ? '***' : '';
    }
    return url.toString();
  } catch {
    return value;
  }
}

function getCurrentRole(): Exclude<TargetRole, 'all'> {
  if (process.env.APP_ROLE === 'app' || process.env.APP_ROLE === 'worker' || process.env.APP_ROLE === 'sandbox') {
    return process.env.APP_ROLE;
  }
  if (process.env.SKILL_HUB_SANDBOX === 'true') {
    return 'sandbox';
  }

  const workerMode = process.env.WORKER_MODE || 'main';
  return workerMode === 'worker' || workerMode === 'task' || workerMode === '*' ? 'worker' : 'app';
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args]
    .map((part) => {
      const value = /^https?:\/\//.test(part) ? redactUrl(part) : part;
      return /^[a-zA-Z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value);
    })
    .join(' ');
}

function parseOsRelease(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;

    values[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return values;
}

function normalizeMirrorUrl(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function isInternalCacheMirror(url: URL): boolean {
  return url.hostname === 'nginx-cache-registry';
}

function resolveAptMirrorForOs(aptMirrorUrl: string, osInfo: AptOsInfo, logs: string[]): string {
  const url = new URL(normalizeMirrorUrl(aptMirrorUrl));
  const original = url.toString();

  if (isInternalCacheMirror(url) && osInfo.id === 'debian' && url.pathname === '/ubuntu/') {
    url.pathname = '/debian/';
  } else if (isInternalCacheMirror(url) && osInfo.id === 'ubuntu' && url.pathname === '/debian/') {
    url.pathname = '/ubuntu/';
  }

  const resolved = url.toString();
  if (resolved !== original) {
    logs.push(`Adjusted APT mirror for ${osInfo.id}: ${redactUrl(resolved)}`);
  }
  return resolved;
}

export class PackageManager {
  constructor(private app: Application) {}

  /**
   * Called from REST action when admin clicks "Install Packages".
   * Publishes task to all nodes via PubSub. Nodes will filter by targetRole.
   */
  async dispatchInstall(payload: InstallPayload): Promise<string> {
    const pubSub = (this.app as any).pubSubManager;
    const connected = pubSub && (await pubSub.isConnected?.());
    if (!connected) {
      throw new Error('PubSub is not connected; package installation cannot be dispatched to cluster nodes.');
    }

    await pubSub.publish(INSTALL_CHANNEL, payload);
    return `Install task dispatched to role: ${payload.targetRole}`;
  }

  async executeInstall(payload: InstallPayload): Promise<void> {
    const { targetRole = 'all', registryConfig = {}, packages = {} } = payload || {};

    // Filter by role
    const currentRole = getCurrentRole();
    const roleMatches =
      targetRole === 'all' || targetRole === currentRole || (targetRole === 'worker' && currentRole === 'sandbox');

    if (!roleMatches) {
      return; // Skip if role doesn't match
    }

    const logs: string[] = [];
    const safePackages = {
      apt: sanitizePackageList(packages.apt),
      npm: sanitizePackageList(packages.npm),
      python: sanitizePackageList(packages.python),
    };

    this.app.logger.info(`[PackageManager] Starting package installation for role ${currentRole}`);
    await this.updateInstallStatus('running', 5, `Starting package installation on ${currentRole}`, logs);

    try {
      await this.updateInstallStatus('running', 10, 'Checking installed packages/modules...', logs);
      const missingPackages = {
        apt: await this.getMissingPackages('apt', safePackages.apt, logs),
        npm: await this.getMissingPackages('npm', safePackages.npm, logs),
        python: await this.getMissingPackages('python', safePackages.python, logs),
      };

      // Step 1: APT packages
      if (missingPackages.apt.length > 0) {
        if (registryConfig.aptMirrorUrl) {
          const aptMirrorUrl = sanitizeHttpUrl(registryConfig.aptMirrorUrl, 'APT mirror URL');
          logs.push(`Applying APT mirror: ${redactUrl(aptMirrorUrl)}`);
          await this.configureAptMirror(aptMirrorUrl, logs);
        }

        await this.updateInstallStatus('running', 20, 'Installing APT packages...', logs);
        await this.runCommand('apt-get', ['update', '-qq'], 'Updating APT package index...', logs, 1200000);
        await this.runCommand(
          'apt-get',
          ['install', '-y', '--no-install-recommends', ...missingPackages.apt],
          'Installing APT packages...',
          logs,
          1200000,
        );
      }

      // Step 2: NPM packages (Global)
      if (missingPackages.npm.length > 0) {
        if (registryConfig.npmRegistryUrl) {
          const npmRegistryUrl = sanitizeHttpUrl(registryConfig.npmRegistryUrl, 'NPM registry URL');
          logs.push(`Applying NPM registry: ${redactUrl(npmRegistryUrl)}`);
          await this.runCommand(
            'npm',
            ['config', 'set', 'registry', npmRegistryUrl, '--location=global'],
            'Configuring NPM registry...',
            logs,
            30000,
          );
        }

        await this.updateInstallStatus('running', 55, 'Installing NPM packages...', logs);
        await this.runCommand(
          'npm',
          ['install', '-g', '--silent', ...missingPackages.npm],
          'Installing NPM packages globally...',
          logs,
          1200000,
        );
      }

      // Step 3: Python packages
      if (missingPackages.python.length > 0) {
        if (registryConfig.pypiIndexUrl) {
          const pypiIndexUrl = sanitizeHttpUrl(registryConfig.pypiIndexUrl, 'PyPI index URL');
          logs.push(`Applying PyPI index: ${redactUrl(pypiIndexUrl)}`);
          await this.runCommand(
            'pip3',
            ['config', 'set', 'global.index-url', pypiIndexUrl],
            'Configuring PyPI registry...',
            logs,
            30000,
          );

          let trustedHost = registryConfig.pypiTrustedHost;
          if (!trustedHost && pypiIndexUrl.startsWith('http://')) {
            trustedHost = new URL(pypiIndexUrl).host;
          }
          if (trustedHost) {
            await this.runCommand(
              'pip3',
              ['config', 'set', 'global.trusted-host', trustedHost],
              `Configuring PyPI trusted host to ${trustedHost}...`,
              logs,
              30000,
            );
          }
        }

        await this.updateInstallStatus('running', 80, 'Installing Python packages...', logs);
        await this.runCommand(
          'pip3',
          ['install', '--no-cache-dir', '--break-system-packages', ...missingPackages.python],
          'Installing Python packages...',
          logs,
          1200000,
        );
      }

      if (!missingPackages.apt.length && !missingPackages.npm.length && !missingPackages.python.length) {
        logs.push('All requested packages/modules are already installed on this node.');
      }

      logs.push(`[OK] Package installation completed successfully on ${currentRole}`);
      this.app.logger.info(`[PackageManager] Install success: \n${logs.join('\n')}`);
      await this.updateInstallStatus('succeeded', 100, `Package installation completed on ${currentRole}`, logs, {
        lastInitLog: logs.join('\n'),
        packageWhitelist: JSON.stringify({
          apt: safePackages.apt,
          python: safePackages.python,
          node: safePackages.npm,
        }),
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logs.push(`FAILED: ${errorMsg}`);
      this.app.logger.error(`[PackageManager] Install failed on ${currentRole}: ${errorMsg}`);
      await this.updateInstallStatus('failed', 100, errorMsg, logs, {
        lastInitLog: logs.join('\n'),
      });
    }
  }

  /**
   * Run a command without a shell so registry URLs and package names are not re-parsed as shell syntax.
   */
  private async runCommand(
    command: string,
    args: string[],
    label: string,
    logs: string[],
    timeoutMs = 1200000,
  ): Promise<void> {
    logs.push(`RUNNING: ${formatCommand(command, args)}`);
    logs.push(`${label}`);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const state: { timer?: NodeJS.Timeout } = {};

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (state.timer) clearTimeout(state.timer);
        if (stdout) logs.push(stdout.slice(0, 500));
        if (stderr) logs.push(`WARN: ${stderr.slice(0, 300)}`);
        if (error) {
          logs.push(`FAILED: ${error.message.slice(0, 500)}`);
          reject(error);
        } else {
          resolve();
        }
      };

      state.timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(new Error(`${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout?.on('data', (chunk) => {
        if (stdout.length < 1000) stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk) => {
        if (stderr.length < 1000) stderr += chunk.toString();
      });
      child.on('error', (error) => finish(error));
      child.on('close', (code, signal) => {
        if (code === 0) {
          finish();
        } else {
          finish(new Error(`${command} exited with ${signal || code}`));
        }
      });
    });
  }

  private async getMissingPackages(kind: PackageKind, packages: string[], logs: string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const pkg of packages) {
      const installed = await this.isPackageInstalled(kind, pkg);
      if (installed) {
        logs.push(`[SKIP] ${kind}:${pkg} is already installed`);
      } else {
        logs.push(`[MISSING] ${kind}:${pkg} will be installed`);
        missing.push(pkg);
      }
    }
    return missing;
  }

  private async isPackageInstalled(kind: PackageKind, pkg: string): Promise<boolean> {
    if (kind === 'apt') {
      return this.runStatus('dpkg-query', ['-W', '-f=${Status}', pkg], 30000, (stdout) =>
        stdout.includes('install ok installed'),
      );
    }
    if (kind === 'npm') {
      return this.runStatus('npm', ['list', '-g', '--depth=0', pkg], 30000);
    }
    return this.runStatus('pip3', ['show', pkg], 30000);
  }

  private async runStatus(
    command: string,
    args: string[],
    timeoutMs = 30000,
    isSuccess?: (stdout: string) => boolean,
  ): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      let settled = false;
      const state: { timer?: NodeJS.Timeout } = {};

      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (state.timer) clearTimeout(state.timer);
        resolve(ok);
      };

      state.timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(false);
      }, timeoutMs);

      child.stdout?.on('data', (chunk) => {
        if (stdout.length < 1000) stdout += chunk.toString();
      });
      child.on('error', () => finish(false));
      child.on('close', (code) => finish(code === 0 && (isSuccess ? isSuccess(stdout) : true)));
    });
  }

  private async getAptOsInfo(): Promise<AptOsInfo> {
    const values = parseOsRelease(await fsp.readFile('/etc/os-release', 'utf8'));
    const id = (values.ID || '').toLowerCase();
    const codename = values.VERSION_CODENAME || values.UBUNTU_CODENAME;

    if (!id || !codename) {
      throw new Error('Cannot detect OS ID/version codename from /etc/os-release for APT mirror configuration.');
    }
    return { id, codename };
  }

  private buildAptSources(aptMirrorUrl: string, osInfo: AptOsInfo): string {
    const mirror = normalizeMirrorUrl(aptMirrorUrl);
    if (osInfo.id === 'ubuntu') {
      return `deb ${mirror} ${osInfo.codename} main universe restricted multiverse\n`;
    }
    if (osInfo.id === 'debian') {
      return `deb ${mirror} ${osInfo.codename} main contrib non-free non-free-firmware\n`;
    }
    return `deb ${mirror} ${osInfo.codename} main\n`;
  }

  private async configureAptMirror(aptMirrorUrl: string, logs: string[]): Promise<void> {
    const osInfo = await this.getAptOsInfo();
    const resolvedMirrorUrl = resolveAptMirrorForOs(aptMirrorUrl, osInfo, logs);
    const backupDir = '/etc/apt/sources.list.d.bak';
    await fsp.mkdir(backupDir, { recursive: true });

    await this.moveIfExists('/etc/apt/sources.list', path.join(backupDir, `sources.list.${Date.now()}.bak`));

    try {
      const sourceListDir = '/etc/apt/sources.list.d';
      const files = await fsp.readdir(sourceListDir);
      for (const file of files) {
        await this.moveIfExists(path.join(sourceListDir, file), path.join(backupDir, `${file}.${Date.now()}.bak`));
      }
    } catch {
      // sources.list.d may not exist in minimal images.
    }

    await fsp.writeFile('/etc/apt/sources.list', this.buildAptSources(resolvedMirrorUrl, osInfo), 'utf8');
  }

  private async moveIfExists(from: string, to: string): Promise<void> {
    try {
      await fsp.rename(from, to);
    } catch {
      // Missing files or permission errors are handled by the caller's next command.
    }
  }

  private async updateInstallStatus(
    initStatus: 'running' | 'succeeded' | 'failed',
    initProgressPercent: number,
    initProgressLog: string,
    logs: string[],
    extraValues: Record<string, any> = {},
  ) {
    try {
      const redisClient = getRedisClient(this.app);
      const podName = process.env.POD_NAME || require('os').hostname();
      if (redisClient) {
        const key = `orchestrator:pkg-status:${podName}`;
        await redisClient.sendCommand([
          'SET',
          key,
          JSON.stringify({
            initStatus,
            initProgressPercent,
            initProgressLog,
            lastInitAt: new Date(),
            lastInitLog: logs.join('\n'),
            ...extraValues,
          }),
          'EX',
          '86400', // expire after 1 day
        ]);
      }

      // We can also keep the global DB record as a fallback/historical record
      const repo = (this.app as any).db.getRepository('workerPackagesConfigs');
      let config = await repo.findOne();
      if (!config) {
        config = await repo.create({ values: {} });
      }
      await repo.update({
        filterByTk: config.get('id'),
        values: {
          initStatus,
          initProgressPercent,
          initProgressLog,
          lastInitAt: new Date(),
          lastInitLog: logs.join('\n'),
          ...extraValues,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.app.logger.warn(`[PackageManager] Failed to update install status: ${message}`);
    }
  }
}
