import { Plugin } from '@nocobase/server';
import { resolve } from 'path';
import { RedisActiveUserAdapter } from './adapters/redis-active-user-adapter';
import { RedisSnapshotAdapter } from './adapters/redis-snapshot-adapter';
import { resolveRedisSnapshotClient } from './adapters/redis-client-resolver';
import { assessCapacityFromSnapshot } from './capacity/capacity-engine';
import { createAppObservabilityContract, registerAppObservability, type AppObservabilityContract } from './contracts';
import { MetricsStore } from './metrics/metrics-store';
import { createHttpObservabilityMiddleware } from './middleware/http-observability';
import { SettingsRepository, DEFAULT_SETTINGS, type ObservabilitySettings } from './repositories/settings-repository';
import { registerAppObservabilityResources } from './resources/app-observability';
import { registerMetricsResource } from './resources/metrics';
import { RuntimeSampler } from './runtime/runtime-sampler';
import { BucketAggregator } from './services/bucket-aggregator';
import { BucketFlushService } from './services/bucket-flush-service';
import { QueryService } from './services/query-service';
import { RetentionService } from './services/retention-service';

export class PluginAppObservabilityServer extends Plugin {
  private store: MetricsStore;
  private contract: AppObservabilityContract;
  private unregisterContract: (() => void) | null = null;
  private sampler: RuntimeSampler | null = null;
  private aggregator: BucketAggregator | null = null;
  private flushService: BucketFlushService | null = null;
  private redisAdapter: RedisSnapshotAdapter | null = null;
  private activeUserAdapter: RedisActiveUserAdapter | null = null;
  private settingsRepository: SettingsRepository;
  private settings: ObservabilitySettings = { ...DEFAULT_SETTINGS, enabled: false };
  private timers: NodeJS.Timeout[] = [];
  private settingsTimer: NodeJS.Timeout | null = null;
  private settingsSync: Promise<void> | null = null;

  async beforeLoad() {
    await this.db.import({ directory: resolve(__dirname, 'collections') });
  }

  async load() {
    const appName = this.app.name || 'main';
    const nodeId = process.env.APP_OBSERVABILITY_NODE_ID || process.env.NODE_ID || `pid-${process.pid}`;
    this.store = new MetricsStore({
      appName,
      nodeId,
      activeUserWindowMs: DEFAULT_SETTINGS.activeUserWindowSeconds * 1000,
    });
    // Contract consumers can be loaded before persisted settings are available.
    // Keep their calls harmless until startup has confirmed collection is enabled.
    this.store.stopAccepting();
    this.contract = createAppObservabilityContract(this.store, {
      getCapacityAssessment: () =>
        assessCapacityFromSnapshot(this.store.getSnapshot(), {
          cpu: this.settings.capacityThresholdCpu,
          memory: this.settings.capacityThresholdMemory,
          eventLoop: this.settings.capacityThresholdEventLoop,
          dbWait: this.settings.capacityThresholdDbWait,
        }),
    });
    this.unregisterContract = registerAppObservability(this.app, this.contract);
    this.settingsRepository = new SettingsRepository(
      this.db.getRepository('appObservabilitySettings') as ConstructorParameters<typeof SettingsRepository>[0],
    );
    const historyRepository = this.db.getRepository('appObservabilityBuckets') as ConstructorParameters<
      typeof QueryService
    >[1];
    const query = new QueryService(
      this.contract,
      historyRepository,
      () => this.redisAdapter,
      () => this.settings.activeUserWindowSeconds,
      (snapshot) =>
        assessCapacityFromSnapshot(snapshot, {
          cpu: this.settings.capacityThresholdCpu,
          memory: this.settings.capacityThresholdMemory,
          eventLoop: this.settings.capacityThresholdEventLoop,
          dbWait: this.settings.capacityThresholdDbWait,
        }),
      () => this.activeUserAdapter?.count(this.settings.activeUserWindowSeconds) ?? Promise.resolve(null),
    );
    registerAppObservabilityResources(this.app as unknown as Parameters<typeof registerAppObservabilityResources>[0], {
      query,
      settings: this.settingsRepository,
      contract: this.contract,
      onSettingsUpdated: this.applySettings,
    });
    registerMetricsResource(this.app as unknown as Parameters<typeof registerMetricsResource>[0], this.contract, {
      enabled: () => this.settings.prometheusEnabled,
      token: () => process.env.APP_OBSERVABILITY_METRICS_TOKEN,
    });
    // Must run on the dataSourceManager chain: `auth` and `acl` live there, and this is the
    // only place ctx.action is populated. Registering on app.use() would place it after the
    // whole resourcer pipeline, losing both ctx.action and ctx.state.currentUser.
    this.app.dataSourceManager.use(
      createHttpObservabilityMiddleware(this.store, {
        enabled: () => this.settings.enabled,
        onActiveUser: this.observeActiveUser,
      }),
      { tag: 'appObservability', after: 'auth' },
    );
    this.app.on('afterStart', this.start);
    this.app.on('beforeStop', this.teardown);
  }

  async install() {
    await this.settingsRepository.ensureDefaults();
  }
  async beforeDisable() {
    await this.teardown();
  }
  async afterEnable() {
    if (!this.unregisterContract) this.unregisterContract = registerAppObservability(this.app, this.contract);
    await this.start();
  }
  async beforeUnload() {
    this.app.off?.('afterStart', this.start);
    this.app.off?.('beforeStop', this.teardown);
    await this.teardown();
  }

  private readonly start = async () => {
    this.startSettingsWatcher();
    await this.syncSettings(true);
  };

  private readonly startServices = async () => {
    if (!this.settings.enabled || this.timers.length) return;
    this.store.startAccepting();
    if (!this.unregisterContract) this.unregisterContract = registerAppObservability(this.app, this.contract);
    const snapshot = this.store.getSnapshot();
    this.sampler = new RuntimeSampler({ dbPool: () => resolveDbPool(this.db.sequelize) });
    this.aggregator = new BucketAggregator({
      appName: snapshot.appName,
      nodeId: snapshot.nodeId,
      workerMode: snapshot.workerMode,
      bucketSeconds: this.settings.bucketSeconds,
    });
    this.aggregator.seed(snapshot);
    this.flushService = new BucketFlushService(
      this.aggregator,
      this.db.getRepository('appObservabilityBuckets') as ConstructorParameters<typeof BucketFlushService>[1],
    );
    if (this.settings.redisSnapshotsEnabled) {
      const client = resolveRedisSnapshotClient(this.app);
      if (client) {
        this.redisAdapter = new RedisSnapshotAdapter(client, { appName: snapshot.appName });
        const secret = process.env.APP_KEY;
        if (secret) {
          const activeUserAdapter = new RedisActiveUserAdapter(client, { appName: snapshot.appName, secret });
          if (activeUserAdapter.supported) this.activeUserAdapter = activeUserAdapter;
        }
      }
    }
    this.addTimer(this.sampleRuntime, this.settings.sampleIntervalSeconds * 1000);
    this.addTimer(this.flushBuckets, this.settings.bucketSeconds * 1000);
    if (this.redisAdapter) this.addTimer(this.publishRedisSnapshot, 10_000);
    this.addTimer(this.cleanupRetention, 86_400_000);
    await this.sampleRuntime();
    await this.publishRedisSnapshot();
    await this.cleanupRetention();
  };

  private readonly applySettings = async (settings: ObservabilitySettings) => {
    await this.stopServices();
    this.settings = settings;
    this.store.setActiveUserWindowMs(settings.activeUserWindowSeconds * 1000);
    if (settings.enabled) await this.startServices();
  };

  private readonly syncSettings = async (force = false) => {
    if (this.settingsSync) return this.settingsSync;
    this.settingsSync = (async () => {
      const settings = await this.settingsRepository.ensureDefaults();
      if (force || !sameSettings(this.settings, settings)) await this.applySettings(settings);
    })().finally(() => {
      this.settingsSync = null;
    });
    return this.settingsSync;
  };

  private startSettingsWatcher(): void {
    if (this.settingsTimer) return;
    this.settingsTimer = setInterval(() => {
      this.syncSettings().catch((error) =>
        this.app.logger.warn('[app-observability] settings refresh failed', { error }),
      );
    }, 10_000);
    this.settingsTimer.unref();
  }

  private stopSettingsWatcher(): void {
    if (!this.settingsTimer) return;
    clearInterval(this.settingsTimer);
    this.settingsTimer = null;
  }

  // Pauses collection but keeps the contract registered, so other plugins that
  // captured it can keep calling into a (no-op) store instead of crashing.
  private readonly stopServices = async () => {
    this.store?.stopAccepting();
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.sampler?.stop();
    this.sampler = null;
    this.redisAdapter = null;
    this.activeUserAdapter = null;
    if (this.aggregator) this.aggregator.record(this.store.getBucketSnapshot());
    if (this.flushService)
      await withTimeout(
        this.flushService.flushAndDrain().catch((error) => {
          this.app.logger.warn('[app-observability] final bucket flush failed', { error });
          return 0;
        }),
        2_000,
      );
  };

  // Full shutdown: stop collecting and release the contract.
  private readonly teardown = async () => {
    this.stopSettingsWatcher();
    await this.stopServices();
    this.unregisterContract?.();
    this.unregisterContract = null;
  };

  private readonly sampleRuntime = async () => {
    if (!this.sampler) return;
    this.store.setRuntimeSnapshot(this.sampler.sample());
  };
  private readonly flushBuckets = async () => {
    if (!this.aggregator || !this.flushService) return;
    this.aggregator.record(this.store.getBucketSnapshot());
    await this.flushService.flush().catch((error) => {
      this.app.logger.warn('[app-observability] bucket flush failed', { error });
      return 0;
    });
  };
  private readonly publishRedisSnapshot = async () => {
    if (this.redisAdapter)
      await this.redisAdapter.publish(this.store.getSnapshot()).catch((error) => {
        this.app.logger.warn('[app-observability] Redis snapshot publish failed', { error });
      });
  };
  private readonly cleanupRetention = async () => {
    const service = new RetentionService(
      this.db.getRepository('appObservabilityBuckets') as ConstructorParameters<typeof RetentionService>[0],
      this.db.getRepository('appObservabilityAlerts') as ConstructorParameters<typeof RetentionService>[1],
    );
    await service.cleanup(this.settings.retentionDays).catch((error) => {
      this.app.logger.warn('[app-observability] retention cleanup failed', { error });
    });
  };
  private readonly observeActiveUser = async (identifier: string | number) => {
    const adapter = this.activeUserAdapter;
    if (!adapter) return;
    await adapter.observe(identifier, this.settings.activeUserWindowSeconds).catch((error) => {
      this.app.logger.warn('[app-observability] active-user publish failed', { error });
    });
  };
  private addTimer(callback: () => Promise<void>, interval: number): void {
    const timer = setInterval(() => {
      callback().catch((error) => this.app.logger.warn('[app-observability] scheduled task failed', { error }));
    }, interval);
    timer.unref();
    this.timers.push(timer);
  }
}

function sameSettings(left: ObservabilitySettings, right: ObservabilitySettings): boolean {
  return (Object.keys(DEFAULT_SETTINGS) as Array<keyof ObservabilitySettings>).every((key) => left[key] === right[key]);
}

interface PoolLike {
  size?: number;
  available?: number;
  using?: number;
  waiting?: number;
}
interface DbPoolStats {
  active: number | null;
  idle: number | null;
  waiting: number | null;
}
const EMPTY_POOL: DbPoolStats = { active: null, idle: null, waiting: null };

// Sequelize exposes either a single pool or, under replication, `{ read, write }`.
export function resolveDbPool(sequelize: object): DbPoolStats {
  const pool = (sequelize as { connectionManager?: { pool?: PoolLike | { read?: PoolLike; write?: PoolLike } } })
    .connectionManager?.pool;
  if (!pool) return EMPTY_POOL;
  const replicated = pool as { read?: PoolLike; write?: PoolLike };
  if (replicated.read || replicated.write) return addPools(readPool(replicated.write), readPool(replicated.read));
  return readPool(pool as PoolLike);
}
function readPool(pool?: PoolLike): DbPoolStats {
  if (!pool || !Number.isFinite(pool.available) || !Number.isFinite(pool.waiting)) return EMPTY_POOL;
  const idle = Number(pool.available);
  const active = Number.isFinite(pool.using) ? Number(pool.using) : Number(pool.size) - idle;
  return {
    active: Number.isFinite(active) ? Math.max(0, active) : null,
    idle,
    waiting: Number(pool.waiting),
  };
}
function addPools(left: DbPoolStats, right: DbPoolStats): DbPoolStats {
  const add = (a: number | null, b: number | null) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
  return {
    active: add(left.active, right.active),
    idle: add(left.idle, right.idle),
    waiting: add(left.waiting, right.waiting),
  };
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      timer.unref();
    }),
  ]);
}

export default PluginAppObservabilityServer;
