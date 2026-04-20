import { exec as execCb } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { promisify } from 'util';
import Application from '@nocobase/server';
import { resolve } from 'path';

const execAsync = promisify(execCb);

/**
 * Predefined packages — matches the Worker Dockerfile / setup-skill-hub.sh list.
 * These are the ONLY packages that will be installed. No custom packages allowed.
 */
export const PREDEFINED_PACKAGES = {
  apt: ['python3', 'python3-pip', 'python3-venv'],
  python: [
    'python-docx', 'openpyxl', 'pandas', 'matplotlib', 'Pillow',
    'reportlab', 'jinja2', 'pyyaml', 'tabulate', 'xlsxwriter',
  ],
  node: [
    'xlsx', 'docx', 'pdfkit', 'csv-parse', 'archiver',
    'sharp', 'lodash', 'dayjs',
  ],
};

export class WorkerEnvManager {
  constructor(
    private app: Application,
    private db: any,
    private storagePath: string,
  ) {
    this.sandboxWorkspace = resolve(storagePath, 'sandbox-workspace');
  }

  private sandboxWorkspace: string;

  /**
   * Called from REST action when admin clicks "Init Environment".
   * Publishes task to ALL workers via EventQueue.
   */
  async initEnvironment(config: any): Promise<string> {
    await this.getOrCreateConfig();
    await this.db.getRepository('skillWorkerConfigs').update({
      filter: {},
      values: { initStatus: 'running', lastInitAt: new Date() },
      forceUpdate: true,
    });

    // Publish to workers via Redis PubSub
    await this.app.pubSubManager.publish('skill-hub.init-env', {
      registryConfig: {
        npmRegistryUrl: config.npmRegistryUrl || null,
        npmAuthToken: config.npmAuthToken || null,
        pypiIndexUrl: config.pypiIndexUrl || null,
        pypiTrustedHost: config.pypiTrustedHost || null,
        aptMirrorUrl: config.aptMirrorUrl || null,
        aptGpgKeyUrl: config.aptGpgKeyUrl || null,
      },
      packages: PREDEFINED_PACKAGES,
    });

    return 'Init environment task dispatched to workers';
  }

  /**
   * Worker-side: execute the environment setup.
   * Called via EventQueue subscription on the worker process.
   */
  async executeInit(payload: any): Promise<void> {
    const { registryConfig, packages } = payload;
    const logs: string[] = [];

    try {
      // Step 1: Configure registries
      await this.configureRegistries(registryConfig, logs);

      // Step 2: Install APT packages (python3, pip)
      await this.runCommand(
        `apt-get update -qq && apt-get install -y --no-install-recommends ${packages.apt.join(' ')} && rm -rf /var/lib/apt/lists/*`,
        'Installing system packages...',
        logs, 20,
      );

      // Step 3: Install Python packages
      await this.runCommand(
        `pip3 install --no-cache-dir --break-system-packages ${packages.python.join(' ')}`,
        'Installing Python packages...',
        logs, 50,
      );

      // Step 4: Setup sandbox workspace logic
      mkdirSync(this.sandboxWorkspace, { recursive: true });
      writeFileSync(resolve(this.sandboxWorkspace, 'package.json'), '{}', 'utf8');

      // Step 5: Install Node.js local packages
      await this.runCommand(
        `npm install --prefix "${this.sandboxWorkspace}" --silent ${packages.node.join(' ')}`,
        'Installing Node.js packages...',
        logs, 75,
      );

      // Step 6: Verify Python
      await this.runCommand(
        `python3 -c "import docx, openpyxl, pandas; print('Python packages OK')"\n`,
        'Verifying Python packages...',
        logs, 90,
      );

      // Step 7: Verify Node
      const nodePath = resolve(this.sandboxWorkspace, 'node_modules').replace(/\\/g, '/');
      const verifyNodeCmd = process.platform === 'win32'
          ? `set NODE_PATH=${nodePath} && node -e "require('xlsx'); require('dayjs'); console.log('Node packages OK')"`
          : `NODE_PATH="${nodePath}" node -e "require('xlsx'); require('dayjs'); console.log('Node packages OK')"`;
      
      await this.runCommand(
        verifyNodeCmd,
        'Verifying Node.js packages...',
        logs, 95,
      );

      logs.push('[100%] Sandbox workspace ready');

      this.publishProgress(100, 'Environment setup complete');

      // Publish success — whitelist = the predefined packages list
      await this.app.pubSubManager.publish('skill-hub.init-env.done', {
        status: 'succeeded',
        log: logs.join('\n'),
        whitelist: packages,
      });

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.app.logger.error(`[skill-hub] Init env failed: ${errorMsg}`);

      await this.app.pubSubManager.publish('skill-hub.init-env.done', {
        status: 'failed',
        log: logs.join('\n') + `\nERROR: ${errorMsg}`,
      });
    }
  }

  /**
   * Write registry config files (.npmrc, pip.conf, apt sources) on the worker.
   */
  private async configureRegistries(config: any, logs: string[]): Promise<void> {
    // npm registry
    if (config.npmRegistryUrl) {
      let npmrc = `registry=${config.npmRegistryUrl}\n`;
      if (config.npmAuthToken) {
        try {
          const url = new URL(config.npmRegistryUrl);
          npmrc += `//${url.host}/:_authToken=${config.npmAuthToken}\n`;
        } catch {
          npmrc += `//registry.npmjs.org/:_authToken=${config.npmAuthToken}\n`;
        }
      }
      try {
        writeFileSync('/root/.npmrc', npmrc);
        logs.push(`Configured npm registry: ${config.npmRegistryUrl}`);
      } catch (e) {
        logs.push(`WARN: Could not write .npmrc: ${e instanceof Error ? e.message : e}`);
      }
    }

    // PyPI index
    if (config.pypiIndexUrl) {
      try {
        mkdirSync('/root/.config/pip', { recursive: true });
        let pipConf = `[global]\nindex-url = ${config.pypiIndexUrl}\n`;
        if (config.pypiTrustedHost) {
          pipConf += `trusted-host = ${config.pypiTrustedHost}\n`;
        }
        writeFileSync('/root/.config/pip/pip.conf', pipConf);
        logs.push(`Configured PyPI index: ${config.pypiIndexUrl}`);
      } catch (e) {
        logs.push(`WARN: Could not write pip.conf: ${e instanceof Error ? e.message : e}`);
      }
    }

    // APT mirror
    if (config.aptMirrorUrl) {
      try {
        const sourceLine = `deb ${config.aptMirrorUrl} bookworm main`;
        mkdirSync('/etc/apt/sources.list.d', { recursive: true });
        writeFileSync('/etc/apt/sources.list.d/custom-mirror.list', sourceLine + '\n');
        if (config.aptGpgKeyUrl) {
          await execAsync(
            `curl -fsSL ${config.aptGpgKeyUrl} | gpg --dearmor -o /etc/apt/trusted.gpg.d/custom.gpg`,
            { timeout: 30000 },
          );
        }
        logs.push(`Configured APT mirror: ${config.aptMirrorUrl}`);
      } catch (e) {
        logs.push(`WARN: Could not configure APT mirror: ${e instanceof Error ? e.message : e}`);
      }
    }

    this.publishProgress(10, 'Registry config applied');
  }

  /**
   * Run a shell command with progress logging.
   */
  private async runCommand(cmd: string, label: string, logs: string[], percent: number): Promise<void> {
    this.publishProgress(percent, label);
    logs.push(`[${percent}%] ${label}`);

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        timeout: 300000, // 5 minutes max
        maxBuffer: 10 * 1024 * 1024,
      });
      if (stdout) logs.push(stdout.slice(0, 500));
      if (stderr) logs.push(`WARN: ${stderr.slice(0, 300)}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logs.push(`FAILED: ${msg.slice(0, 500)}`);
      throw error;
    }
  }

  private publishProgress(percent: number, log: string) {
    this.app.pubSubManager.publish('skill-hub.init-env.progress', { percent, log }).catch(() => {});
  }

  async getOrCreateConfig() {
    const repo = this.db.getRepository('skillWorkerConfigs');
    let config = await repo.findOne();
    if (!config) {
      config = await repo.create({ values: {} });
    }
    return config;
  }
}
