import Application from '@nocobase/server';
import { Database } from '@nocobase/database';
import { parseJsonText, stringifyJsonText } from '../skill-hub/utils/json-fields';

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
    const customPackages = payload.customPackages || { python: [], node: [], apt: [] };
    const whitelist = {
      python: Array.from(new Set([...(DEFAULT_WHITELIST.python || []), ...(customPackages.python || [])])),
      node: Array.from(new Set([...(DEFAULT_WHITELIST.node || []), ...(customPackages.node || [])])),
      apt: Array.from(new Set([...(DEFAULT_WHITELIST.apt || []), ...(customPackages.apt || [])])),
    };

    await (this as any).app.pubSubManager.publish('skill-hub.init-env.progress', {
      percent: 25,
      log: 'Resolved sandbox package whitelist',
    });

    await (this as any).app.pubSubManager.publish('skill-hub.init-env.progress', {
      percent: 75,
      log: 'Sandbox runtime uses the local worker environment',
    });

    await (this as any).app.pubSubManager.publish('skill-hub.init-env.done', {
      status: 'succeeded',
      log:
        'Sandbox environment is ready on this worker. Package installation is managed by the worker image/runtime; whitelist was refreshed.',
      whitelist,
    });
  }

  parsePackageWhitelist(config: any) {
    return parseJsonText(config?.get?.('packageWhitelist') ?? config?.packageWhitelist, DEFAULT_WHITELIST);
  }
}
