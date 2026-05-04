import { PackageManager } from '../orchestrator/PackageManager';
import {
  DEFAULT_WORKER_PACKAGES,
  formatPackageText,
  packagesFromConfig,
  type CustomPackageMap,
  type WorkerPackageMap,
} from '../../shared/packages';

function parseJsonField<T>(value: any, fallback: T): T {
  if (!value) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function uniquePackages(packages: Array<string | undefined>): string[] {
  return Array.from(new Set(packages.filter((pkg) => typeof pkg === 'string').map((pkg) => pkg.trim()).filter(Boolean)));
}

function buildPackagePayload(config: any, requested: any = {}): WorkerPackageMap {
  if (requested?.apt || requested?.npm || requested?.node || requested?.python) {
    return {
      apt: uniquePackages([...(requested.apt || [])]),
      npm: uniquePackages([...(requested.npm || []), ...(requested.node || [])]),
      python: uniquePackages([...(requested.python || [])]),
    };
  }

  const configured = packagesFromConfig({
    aptPackages: config.get('aptPackages'),
    pythonPackages: config.get('pythonPackages'),
    npmPackages: config.get('npmPackages'),
  });
  const custom = parseJsonField<CustomPackageMap>(config.get('customPackages'), { python: [], node: [], npm: [] });
  return {
    apt: uniquePackages([...(configured.apt || [])]),
    npm: uniquePackages([
      ...(configured.npm || []),
      ...(custom.node || []),
      ...(custom.npm || []),
    ]),
    python: uniquePackages([...(configured.python || []), ...(custom.python || [])]),
  };
}

export const packageManagerActions = {
  async installPackages(ctx: any, next: () => Promise<void>) {
    const payload = ctx.action.params.values || ctx.request?.body?.values || ctx.request?.body || {};
    const pm = new PackageManager(ctx.app);
    
    // Save or update config in DB
    const repo = ctx.db.getRepository('workerPackagesConfigs');
    let config = await repo.findOne();
    if (!config) {
      config = await repo.create({ values: {} });
    }
    
    await repo.update({
      filterByTk: config.get('id'),
      values: { 
        initStatus: 'running', 
        lastInitAt: new Date(),
        initProgressPercent: 0,
        initProgressLog: `Task queued for ${payload.targetRole || 'all'}...`
      },
    });

    try {
      const result = await pm.dispatchInstall({
        targetRole: payload.targetRole || 'all',
        packages: buildPackagePayload(config, payload.packages),
        registryConfig: payload.registryConfig || {
          aptMirrorUrl: config.get('aptMirrorUrl') || process.env.APT_MIRROR_URL,
          npmRegistryUrl: config.get('npmRegistryUrl') || process.env.NPM_REGISTRY_URL,
          pypiIndexUrl: config.get('pypiIndexUrl') || process.env.PYPI_INDEX_URL,
          pypiTrustedHost: config.get('pypiTrustedHost') || process.env.PYPI_TRUSTED_HOST,
        },
      });

      ctx.body = { success: true, message: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await repo.update({
        filterByTk: config.get('id'),
        values: {
          initStatus: 'failed',
          initProgressPercent: 100,
          initProgressLog: message,
          lastInitLog: message,
        },
      });
      throw error;
    }
    await next();
  },

  async getPackageConfig(ctx: any, next: () => Promise<void>) {
    const repo = ctx.db.getRepository('workerPackagesConfigs');
    let config = await repo.findOne();
    if (!config) {
      config = await repo.create({
        values: {
          aptPackages: formatPackageText(DEFAULT_WORKER_PACKAGES.apt),
          pythonPackages: formatPackageText(DEFAULT_WORKER_PACKAGES.python),
          npmPackages: formatPackageText(DEFAULT_WORKER_PACKAGES.npm),
        },
      });
    }
    const json = config.toJSON();
    
    // Fallback to ENV variables if not set in DB
    json.npmRegistryUrl = json.npmRegistryUrl || process.env.NPM_REGISTRY_URL;
    json.aptMirrorUrl = json.aptMirrorUrl || process.env.APT_MIRROR_URL;
    json.pypiIndexUrl = json.pypiIndexUrl || process.env.PYPI_INDEX_URL;
    json.pypiTrustedHost = json.pypiTrustedHost || process.env.PYPI_TRUSTED_HOST;
    
    ctx.body = json;
    await next();
  },
  
  async savePackageConfig(ctx: any, next: () => Promise<void>) {
    const values = ctx.action.params.values || ctx.request?.body?.values || ctx.request?.body || {};
    const repo = ctx.db.getRepository('workerPackagesConfigs');
    let config = await repo.findOne();
    if (config) {
      await repo.update({ filterByTk: config.get('id'), values });
    } else {
      await repo.create({ values });
    }
    ctx.body = { success: true, message: 'Settings saved.' };
    await next();
  },

  async resetInitStatus(ctx: any, next: () => Promise<void>) {
    const repo = ctx.db.getRepository('workerPackagesConfigs');
    let config = await repo.findOne();
    if (config) {
      await repo.update({
        filterByTk: config.get('id'),
        values: {
          initStatus: 'failed',
          initProgressLog: 'Stopped by user',
          lastInitLog: 'Stopped by user',
        },
      });
    }
    ctx.body = { success: true, message: 'Status reset to stopped.' };
    await next();
  }
};
