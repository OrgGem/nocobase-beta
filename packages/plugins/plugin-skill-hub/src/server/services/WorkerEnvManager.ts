import { exec as execCb } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, cpSync, readFileSync } from 'fs';
import { promisify } from 'util';
import Application from '@nocobase/server';
import { resolve } from 'path';
import { parseJsonText } from '../utils/json-fields';

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
    'python-pptx',
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
      values: { 
        initStatus: 'running', 
        lastInitAt: new Date(),
        initProgressPercent: 0,
        initProgressLog: 'Task queued, waiting for worker...'
      },
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
      packages: {
        apt: PREDEFINED_PACKAGES.apt,
        python: Array.from(new Set([...PREDEFINED_PACKAGES.python, ...(parseJsonText(config.customPackages, { python: [], node: [] }).python || [])])),
        node: Array.from(new Set([...PREDEFINED_PACKAGES.node, ...(parseJsonText(config.customPackages, { python: [], node: [] }).node || [])])),
      },
    });

    return 'Init environment task dispatched to workers';
  }

  async executeInit(payload: any): Promise<void> {
    const { registryConfig, packages } = payload;
    const logs: string[] = [];

    try {
      // Step 1: Configure APT registries and disable default repos
      if (registryConfig.aptMirrorUrl) {
         logs.push(`Applying APT mirror: ${registryConfig.aptMirrorUrl}`);
         // Backup current and replace so we don't hang on default repos without internet
         const gpgCmd = registryConfig.aptGpgKeyUrl ? `curl -fsSL ${registryConfig.aptGpgKeyUrl} | gpg --dearmor -o /etc/apt/trusted.gpg.d/custom.gpg && ` : '';
         const aptScript = `
           ${gpgCmd}mkdir -p /etc/apt/sources.list.d.bak && \
           mv /etc/apt/sources.list /etc/apt/sources.list.d.bak/ 2>/dev/null || true && \
           mv /etc/apt/sources.list.d/* /etc/apt/sources.list.d.bak/ 2>/dev/null || true && \
           echo "deb ${registryConfig.aptMirrorUrl} bookworm main" > /etc/apt/sources.list
         `.trim();
         await this.runCommand(aptScript, 'Configuring APT registry...', logs, 10, 30000);
      } else {
         this.publishProgress(10, 'Skipping APT registry config');
      }

      // Step 2: Install APT packages (python3, pip)
      await this.runCommand(
        `apt-get update -qq && apt-get install -y --no-install-recommends ${packages.apt.join(' ')} && rm -rf /var/lib/apt/lists/*`,
        'Installing system packages...',
        logs, 20,
        300000
      );

      // Step 3: Configure PyPI registries (Now that Python/pip is installed)
      if (registryConfig.pypiIndexUrl) {
         logs.push(`Applying PyPI index: ${registryConfig.pypiIndexUrl}`);
         let pipConfCmd = `pip3 config set global.index-url ${registryConfig.pypiIndexUrl}`;
         if (registryConfig.pypiTrustedHost) {
           pipConfCmd += ` && pip3 config set global.trusted-host ${registryConfig.pypiTrustedHost}`;
         }
         await this.runCommand(pipConfCmd, 'Configuring PyPI registry...', logs, 40, 30000);
      } else {
         this.publishProgress(40, 'Skipping PyPI registry config');
      }

      // Step 4: Install Python packages
      await this.runCommand(
        `pip3 install --no-cache-dir --break-system-packages ${packages.python.join(' ')}`,
        'Installing Python packages...',
        logs, 50,
        300000
      );

      // Step 5: Setup sandbox workspace logic
      mkdirSync(this.sandboxWorkspace, { recursive: true });
      writeFileSync(resolve(this.sandboxWorkspace, 'package.json'), '{}', 'utf8');

      // Step 5b: Copy bundled Python packages (svg_to_pptx etc.)
      this.copyBundledPythonPackages(logs);

      // Step 6: Configure NPM registries
      if (registryConfig.npmRegistryUrl) {
         logs.push(`Applying NPM registry: ${registryConfig.npmRegistryUrl}`);
         let npmCfgScript = `npm config set registry ${registryConfig.npmRegistryUrl} --location=global`;
         if (registryConfig.npmAuthToken) {
           try {
             const url = new URL(registryConfig.npmRegistryUrl);
             npmCfgScript += ` && npm config set //${url.host}/:_authToken="${registryConfig.npmAuthToken}" --location=global`;
           } catch {
             npmCfgScript += ` && npm config set //registry.npmjs.org/:_authToken="${registryConfig.npmAuthToken}" --location=global`;
           }
         }
         await this.runCommand(npmCfgScript, 'Configuring NPM registry...', logs, 60, 30000);
      } else {
         this.publishProgress(60, 'Skipping NPM registry config');
      }

      // Step 7: Install Node.js local packages
      await this.runCommand(
        `npm install --prefix "${this.sandboxWorkspace}" --silent ${packages.node.join(' ')}`,
        'Installing Node.js packages...',
        logs, 75,
        300000
      );

      // Step 8: Verify Python
      await this.runCommand(
        `python3 -c "import docx, openpyxl, pandas; print('Python packages OK')"\n`,
        'Verifying Python packages...',
        logs, 90,
        30000
      );

      // Step 9: Verify Node
      const nodePath = resolve(this.sandboxWorkspace, 'node_modules').replace(/\\/g, '/');
      const sandboxConfig = JSON.parse(readFileSync(resolve(__dirname, '../sandbox-config.json'), 'utf-8'));
      const requires = sandboxConfig.verifyPackages.map((pkg: string) => `require('${pkg}');`).join(' ');
      const checkScript = `
        try {
          ${requires}
          console.log('Node packages OK');
        } catch (e) {
          console.error(e.message);
          process.exit(1);
        }
      `;
      const verifyNodeCmd = process.platform === 'win32'
          ? `set NODE_PATH=${nodePath} && node -e "${checkScript.replace(/\n/g, ' ')}"`
          : `NODE_PATH="${nodePath}" node -e "${checkScript.replace(/\n/g, ' ')}"`;
      
      await this.runCommand(
        verifyNodeCmd,
        'Verifying Node.js packages...',
        logs, 95,
        30000
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
   * Run a shell command with progress logging.
   */
  private async runCommand(cmd: string, label: string, logs: string[], percent: number, timeoutMs = 300000): Promise<void> {
    this.publishProgress(percent, label);
    logs.push(`[${percent}%] RUNNING: ${cmd}`);
    logs.push(`[${percent}%] ${label}`);

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        timeout: timeoutMs,
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

  /**
   * Copy bundled Python packages (e.g. svg_to_pptx) to the sandbox workspace
   * so they are available on PYTHONPATH during skill execution.
   */
  private copyBundledPythonPackages(logs: string[]) {
    const pythonPkgDir = resolve(this.sandboxWorkspace, 'python_packages');
    mkdirSync(pythonPkgDir, { recursive: true });

    // Resolve scripts directory relative to plugin package root
    // In dev: __dirname = src/server/services/ → ../../../../scripts/
    // In dist: __dirname = dist/server/services/ → ../../../../scripts/
    const candidates = [
      resolve(__dirname, '../../../scripts'),         // from dist/server/services or src/server/services
      resolve(__dirname, '../../../../scripts'),      // fallback
    ];

    let scriptsDir: string | null = null;
    for (const candidate of candidates) {
      if (existsSync(resolve(candidate, 'svg_to_pptx', '__init__.py'))) {
        scriptsDir = candidate;
        break;
      }
    }

    if (!scriptsDir) {
      logs.push('[WARN] Bundled Python scripts not found, skipping svg_to_pptx install');
      return;
    }

    const srcPkg = resolve(scriptsDir, 'svg_to_pptx');
    const destPkg = resolve(pythonPkgDir, 'svg_to_pptx');

    try {
      cpSync(srcPkg, destPkg, { recursive: true, force: true });
      logs.push(`[OK] Copied svg_to_pptx package to ${destPkg}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logs.push(`[WARN] Failed to copy svg_to_pptx: ${msg}`);
    }
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
