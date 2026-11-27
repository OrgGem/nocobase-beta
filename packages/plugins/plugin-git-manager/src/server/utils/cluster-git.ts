// SPDX-License-Identifier: Apache-2.0

const CLUSTER_INSTALL_CHANNEL = 'cluster-manager.install-packages';
const AUTO_RESTORE_LOCK_KEY = 'git-manager:cluster-git-install';
const AUTO_RESTORE_COOLDOWN_MS = 45_000;

let lastDispatchAt = 0;

interface RecordGetter {
  get(attribute: string): unknown;
}

interface PackageConfigRepository {
  findOne(): Promise<RecordGetter | null>;
  create(options: { values: Record<string, unknown> }): Promise<RecordGetter>;
  update(options: { filterByTk: unknown; values: Record<string, unknown> }): Promise<unknown>;
}

interface PubSubLike {
  isConnected?: () => Promise<boolean> | boolean;
  publish(channel: string, payload: unknown): Promise<unknown>;
}

interface LockManagerLike {
  runExclusive<T>(key: string, fn: () => Promise<T>, ttl?: number): Promise<T>;
}

export interface ClusterGitApp {
  pm?: { get?: (name: string) => unknown };
  db?: {
    getCollection?: (name: string) => unknown;
    getRepository?: (name: string) => PackageConfigRepository | undefined;
  };
  pubSubManager?: PubSubLike;
  lockManager?: LockManagerLike;
  log?: {
    info?: (message: string, meta?: unknown) => void;
    warn?: (message: string, meta?: unknown) => void;
    error?: (message: string, meta?: unknown) => void;
  };
}

export interface ClusterGitStatus {
  available: boolean;
  gitConfigured: boolean;
  previouslyInitialized: boolean;
  status: 'idle' | 'running' | 'succeeded' | 'failed';
  progressPercent: number;
}

function parseAptPackages(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return Array.from(
    new Set(
      raw
        .split(/[\r\n,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function hasGitInWhitelist(raw: unknown): boolean {
  if (!raw) return false;
  try {
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as { apt?: unknown }) : (raw as { apt?: unknown });
    return Array.isArray(parsed?.apt) && parsed.apt.includes('git');
  } catch {
    return false;
  }
}

function normalizeStatus(raw: unknown): ClusterGitStatus['status'] {
  if (raw === 'running' || raw === 'succeeded' || raw === 'failed') return raw;
  return 'idle';
}

function isClusterManagerEnabled(app?: ClusterGitApp): boolean {
  if (!app?.db?.getCollection?.('workerPackagesConfigs')) return false;
  if (!app.pm?.get) return true;
  return Boolean(app.pm.get('plugin-cluster-manager') || app.pm.get('cluster-manager'));
}

export async function readClusterGitStatus(app?: ClusterGitApp): Promise<ClusterGitStatus> {
  if (!isClusterManagerEnabled(app)) {
    return {
      available: false,
      gitConfigured: false,
      previouslyInitialized: false,
      status: 'idle',
      progressPercent: 0,
    };
  }

  const repo = app?.db?.getRepository?.('workerPackagesConfigs');
  if (!repo) {
    return {
      available: false,
      gitConfigured: false,
      previouslyInitialized: false,
      status: 'idle',
      progressPercent: 0,
    };
  }

  const config = await repo.findOne();
  if (!config) {
    return {
      available: true,
      gitConfigured: false,
      previouslyInitialized: false,
      status: 'idle',
      progressPercent: 0,
    };
  }

  const aptPackages = parseAptPackages(config.get('aptPackages'));
  const whitelisted = hasGitInWhitelist(config.get('packageWhitelist'));
  const status = normalizeStatus(config.get('initStatus'));
  const rawPercent = Number(config.get('initProgressPercent') ?? 0);

  return {
    available: true,
    gitConfigured: aptPackages.includes('git') || whitelisted,
    previouslyInitialized: Boolean(config.get('lastInitAt') || whitelisted || status === 'succeeded'),
    status,
    progressPercent: Number.isFinite(rawPercent) ? Math.min(Math.max(rawPercent, 0), 100) : 0,
  };
}

export async function dispatchClusterGitInstall(
  app: ClusterGitApp | undefined,
  options: { ensureGitInConfig?: boolean; force?: boolean } = {},
): Promise<{ dispatched: boolean; reason?: string }> {
  if (!isClusterManagerEnabled(app)) {
    return { dispatched: false, reason: 'Cluster Manager plugin is not enabled' };
  }

  const pubSub = app?.pubSubManager;
  const connected = pubSub ? (pubSub.isConnected ? await pubSub.isConnected() : true) : false;
  if (!pubSub || !connected) {
    return { dispatched: false, reason: 'Cluster PubSub is not connected' };
  }

  const repo = app?.db?.getRepository?.('workerPackagesConfigs');
  if (!repo) {
    return { dispatched: false, reason: 'Cluster package configuration repository is unavailable' };
  }

  const runDispatch = async (): Promise<{ dispatched: boolean; reason?: string }> => {
    const now = Date.now();
    if (!options.force && now - lastDispatchAt < AUTO_RESTORE_COOLDOWN_MS) {
      return { dispatched: false, reason: 'Recent install dispatch still in cooldown' };
    }

    let config = await repo.findOne();
    if (!config) {
      if (!options.ensureGitInConfig) {
        return { dispatched: false, reason: 'Cluster package configuration has not been initialized' };
      }
      config = await repo.create({ values: { aptPackages: 'git' } });
    }

    const currentStatus = normalizeStatus(config.get('initStatus'));
    if (!options.force && currentStatus === 'running') {
      return { dispatched: false, reason: 'Cluster package installation is already running' };
    }

    const aptPackages = parseAptPackages(config.get('aptPackages'));
    if (!aptPackages.includes('git')) {
      if (!options.ensureGitInConfig && !hasGitInWhitelist(config.get('packageWhitelist'))) {
        return { dispatched: false, reason: 'git is not configured in Cluster Manager packages' };
      }
      if (options.ensureGitInConfig) {
        aptPackages.push('git');
      }
    }

    const aptMirrorUrl = String(config.get('aptMirrorUrl') || process.env.APT_MIRROR_URL || '').trim() || undefined;
    await repo.update({
      filterByTk: config.get('id'),
      values: {
        ...(options.ensureGitInConfig ? { aptPackages: aptPackages.join('\n') } : {}),
        initStatus: 'running',
        lastInitAt: new Date(),
        initProgressPercent: 5,
        initProgressLog: 'Installing git on app/worker nodes via Cluster Manager...',
      },
    });

    await pubSub.publish(CLUSTER_INSTALL_CHANNEL, {
      targetRole: 'all',
      packages: { apt: ['git'] },
      registryConfig: { aptMirrorUrl },
    });
    lastDispatchAt = Date.now();
    app?.log?.info?.('plugin-git-manager: dispatched git installation via Cluster Manager');
    return { dispatched: true };
  };

  if (app?.lockManager?.runExclusive) {
    return app.lockManager.runExclusive(AUTO_RESTORE_LOCK_KEY, runDispatch, 30_000);
  }
  return runDispatch();
}

export function resetClusterGitDispatchCooldownForTests(): void {
  lastDispatchAt = 0;
}
