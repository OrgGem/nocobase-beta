import { Plugin } from '@nocobase/server';
import { resolve } from 'path';
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
  private settingsRepository: SettingsRepository;
  private settings: ObservabilitySettings = DEFAULT_SETTINGS;
  private timers: NodeJS.Timeout[] = [];

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
    const query = new QueryService(this.contract, historyRepository, () => this.redisAdapter);
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
    this.app.use(createHttpObservabilityMiddleware(this.store, { enabled: () => this.settings.enabled }), {
      tag: 'appObservability',
      after: 'auth',
      before: 'resourcer',
    });
    this.app.on('afterStart', this.startServices);
    this.app.on('beforeStop', this.stopServices);
  }

  async install() {
    await this.settingsRepository.ensureDefaults();
  }
  async beforeDisable() {
    await this.stopServices();
  }
  async afterEnable() {
    if (!this.unregisterContract) this.unregisterContract = registerAppObservability(this.app, this.contract);
    this.store.startAccepting();
    await this.startServices();
  }
  async beforeUnload() {
    this.app.off?.('afterStart', this.startServices);
    this.app.off?.('beforeStop', this.stopServices);
    await this.stopServices();
  }

  private readonly startServices = async () => {
    this.settings = await this.settingsRepository.ensureDefaults();
    this.store.setActiveUserWindowMs(this.settings.activeUserWindowSeconds * 1000);
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
      if (client) this.redisAdapter = new RedisSnapshotAdapter(client, { appName: snapshot.appName });
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

  private readonly stopServices = async () => {
    this.store?.stopAccepting();
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.sampler?.stop();
    this.sampler = null;
    this.redisAdapter = null;
    if (this.aggregator) this.aggregator.record(this.store.getSnapshot());
    if (this.flushService)
      await withTimeout(
        this.flushService.flush().catch((error) => {
          this.app.logger.warn('[app-observability] final bucket flush failed', { error });
          return 0;
        }),
        2_000,
      );
    this.unregisterContract?.();
    this.unregisterContract = null;
  };

  private readonly sampleRuntime = async () => {
    if (!this.sampler) return;
    this.store.setRuntimeSnapshot(this.sampler.sample());
  };
  private readonly flushBuckets = async () => {
    if (!this.aggregator || !this.flushService) return;
    this.aggregator.record(this.store.getSnapshot());
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
  private addTimer(callback: () => Promise<void>, interval: number): void {
    const timer = setInterval(() => {
      callback().catch((error) => this.app.logger.warn('[app-observability] scheduled task failed', { error }));
    }, interval);
    timer.unref();
    this.timers.push(timer);
  }
}

interface PoolLike {
  size?: number;
  available?: number;
  pending?: number;
}
function resolveDbPool(sequelize: object): { active: number | null; idle: number | null; waiting: number | null } {
  const pool = (sequelize as { connectionManager?: { pool?: PoolLike } }).connectionManager?.pool;
  if (!pool || !Number.isFinite(pool.size) || !Number.isFinite(pool.available) || !Number.isFinite(pool.pending))
    return { active: null, idle: null, waiting: null };
  return {
    active: Math.max(0, Number(pool.size) - Number(pool.available)),
    idle: Number(pool.available),
    waiting: Number(pool.pending),
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
