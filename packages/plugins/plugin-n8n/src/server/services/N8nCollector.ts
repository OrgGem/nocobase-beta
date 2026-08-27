import type { PluginN8nServer } from '../plugin';
import { N8nApiClient } from './N8nApiClient';
import { runWithDistributedLock } from './ha-lock';

export interface MetricsSnapshot {
  timestamp: number;
  cpu: number;
  memoryRss: number;
  heapUsed: number;
  heapTotal: number;
  eventLoopLag: number;
  eventLoopP99: number;
  activeHandles: number;
  activeRequests: number;
  queueWaiting: number;
  queueActive: number;
  queueCompleted: number;
  queueFailed: number;
  activeWorkflows: number;
}

interface N8nExecutionItem {
  id: string | number;
  workflowId?: string | number;
  workflowData?: { name?: string };
  status?: string;
  mode?: string;
  finished?: boolean;
  startedAt?: string;
  stoppedAt?: string;
}

interface NormalizedExecution {
  instanceId: number;
  executionId: string;
  workflowId: string;
  workflowName: string;
  status: string;
  mode: string;
  finished: boolean;
  startedAt: string | null;
  stoppedAt: string | null;
  durationMs: number;
}

const SCHEDULER_TICK_MS = 15_000;
const WORKFLOW_SYNC_EVERY_N_INTERVALS = 5;
const WORKFLOW_SYNC_MIN_GAP_MS = 5 * 60_000;
const MAX_EXEC_PAGES_PER_SYNC = 5;
const EXEC_PAGE_SIZE = 100;
const HOURLY_RETENTION_DAYS = 90;
const DEFAULT_INTERVAL_SECONDS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeStatus(status: string): string {
  if (status === 'success' || status === 'running' || status === 'waiting') return status;
  // error, canceled, crashed, new → grouped as error for monitoring purposes
  return 'error';
}

function hourBucketOf(date: Date): Date {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d;
}

function counterRate(current: number, previous: number | null, dtSec: number): number {
  if (previous == null || dtSec <= 0) return 0;
  const delta = current - previous;
  // Counter reset on n8n restart → treat as 0 instead of a negative spike
  return delta > 0 ? delta / dtSec : 0;
}

/**
 * Background collector: the only component that talks to the n8n API on a
 * schedule. All monitoring UI reads from the local collections it maintains:
 * n8nMetricsSnapshots, n8nExecutionHistory, n8nExecutionHourly, n8nWorkflowStats.
 */
export class N8nCollector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private plugin: PluginN8nServer) {}

  start() {
    if (this.timer) return;
    this.timer = runWithDistributedLock(
      this.plugin.app,
      'n8n:collector',
      async () => {
        await this.runSchedulerTick();
      },
      SCHEDULER_TICK_MS,
    );
    this.plugin.db.on('n8nInstances.afterDestroy', this.onInstanceDestroyed);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.plugin.db.off('n8nInstances.afterDestroy', this.onInstanceDestroyed);
  }

  private get logger() {
    return this.plugin.app.logger;
  }

  private get db() {
    return this.plugin.db;
  }

  private onInstanceDestroyed = async (model: { get: (key: string) => unknown }) => {
    const id = Number(model.get('id'));
    if (!id) return;
    try {
      await Promise.all([
        this.db.getRepository('n8nMetricsSnapshots').destroy({ filter: { instanceId: id } }),
        this.db.getRepository('n8nExecutionHistory').destroy({ filter: { instanceId: id } }),
        this.db.getRepository('n8nExecutionHourly').destroy({ filter: { instanceId: id } }),
        this.db.getRepository('n8nWorkflowStats').destroy({ filter: { instanceId: id } }),
      ]);
    } catch (err) {
      this.logger.warn(`[plugin-n8n] failed to clean up data for deleted instance ${id}: ${err}`);
    }
  };

  private async runSchedulerTick() {
    if (this.running) return;
    this.running = true;
    try {
      const repo = this.db.getRepository('n8nInstances');
      const instances = await repo.find({ filter: { enabled: true, collectEnabled: true } });
      const now = Date.now();

      for (const instance of instances) {
        const id = Number(instance.get('id'));
        const intervalSec = Number(instance.get('collectIntervalSeconds')) || DEFAULT_INTERVAL_SECONDS;
        const last = instance.get('lastCollectedAt') as string | Date | null;
        if (last && now - new Date(last).getTime() < intervalSec * 1000) continue;
        await this.requestCollect(id, intervalSec);
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Collect one instance, guarded by a distributed lock so that only one
   * container in an HA setup fetches from n8n at a time.
   */
  async requestCollect(instanceId: number, intervalSec = DEFAULT_INTERVAL_SECONDS): Promise<boolean> {
    const lockKey = `plugin-n8n:collect-lock:${instanceId}`;
    const locked = await this.plugin.app.cache.get(lockKey);
    if (locked) return false;
    await this.plugin.app.cache.set(lockKey, '1', Math.max(15_000, intervalSec * 500));

    try {
      await this.collectInstance(instanceId);
      return true;
    } catch (err) {
      this.logger.debug(`[plugin-n8n] collect failed for instance ${instanceId}: ${err}`);
      return false;
    }
  }

  private async collectInstance(instanceId: number) {
    const instanceRepo = this.db.getRepository('n8nInstances');
    const instance = await instanceRepo.findOne({ filter: { id: instanceId } });
    if (!instance) return;

    const baseUrl = (instance.get('internalUrl') || instance.get('baseUrl')) as string;
    const apiKey = instance.get('apiKey') as string;
    if (!baseUrl || !apiKey) return;

    const client = new N8nApiClient(baseUrl, apiKey);
    const now = new Date();

    const health = await client.healthCheck();

    let snapshot: Record<string, unknown> | null = null;
    if (instance.get('metricsEnabled')) {
      snapshot = await this.collectMetrics(instanceId, client, health);
    } else {
      // Health-only snapshot so uptime history works without Prometheus metrics
      await this.db.getRepository('n8nMetricsSnapshots').create({
        values: { instanceId, timestamp: now, healthStatus: health.status, healthLatency: health.latencyMs },
      });
    }

    await this.syncExecutions(instanceId, client);
    await this.maybeSyncWorkflows(instanceId, client, instance);
    await this.checkWorkers(instanceId, instance);
    await this.prune(instanceId, Number(instance.get('retentionDays')) || 7);

    await instanceRepo.update({
      filter: { id: instanceId },
      values: {
        lastCollectedAt: now,
        lastHealthStatus: health.status,
        lastHealthLatency: health.latencyMs,
      },
    });

    if (snapshot) {
      await this.evaluateAlerts(instanceId, snapshot);
    }
  }

  private async collectMetrics(
    instanceId: number,
    client: N8nApiClient,
    health: { status: string; latencyMs: number },
  ): Promise<Record<string, unknown>> {
    const metrics: MetricsSnapshot = await client.getMetricsSnapshot();
    const snapRepo = this.db.getRepository('n8nMetricsSnapshots');

    const prev = await snapRepo.findOne({ filter: { instanceId }, sort: ['-timestamp'] });

    let cpuRate = 0;
    let queueThroughput = 0;
    let queueFailRate = 0;
    if (prev) {
      const dtSec = (metrics.timestamp - new Date(prev.get('timestamp') as Date).getTime()) / 1000;
      cpuRate = counterRate(metrics.cpu, prev.get('cpu') as number | null, dtSec);
      queueThroughput = counterRate(metrics.queueCompleted, prev.get('queueCompleted') as number | null, dtSec);
      queueFailRate = counterRate(metrics.queueFailed, prev.get('queueFailed') as number | null, dtSec);
    }

    const values: Record<string, unknown> = {
      ...metrics,
      instanceId,
      cpuRate,
      queueThroughput,
      queueFailRate,
      healthStatus: health.status,
      healthLatency: health.latencyMs,
    };
    await snapRepo.create({ values });
    return values;
  }

  private normalizeExecution(instanceId: number, e: N8nExecutionItem): NormalizedExecution {
    const startedAt = e.startedAt || null;
    const stoppedAt = e.stoppedAt || null;
    const durationMs =
      startedAt && stoppedAt ? Math.max(0, new Date(stoppedAt).getTime() - new Date(startedAt).getTime()) : 0;
    return {
      instanceId,
      executionId: String(e.id),
      workflowId: String(e.workflowId ?? ''),
      workflowName: e.workflowData?.name || '',
      status: normalizeStatus(String(e.status || 'error')),
      mode: e.mode || '',
      finished: Boolean(e.finished),
      startedAt,
      stoppedAt,
      durationMs,
    };
  }

  private rowToExecution(row: { get: (key: string) => unknown }): NormalizedExecution {
    return {
      instanceId: Number(row.get('instanceId')),
      executionId: String(row.get('executionId')),
      workflowId: String(row.get('workflowId')),
      workflowName: (row.get('workflowName') as string) || '',
      status: (row.get('status') as string) || 'error',
      mode: (row.get('mode') as string) || '',
      finished: Boolean(row.get('finished')),
      startedAt: (row.get('startedAt') as string) || null,
      stoppedAt: (row.get('stoppedAt') as string) || null,
      durationMs: Number(row.get('durationMs')) || 0,
    };
  }

  /**
   * Incrementally sync executions (newest first). Stops paging as soon as an
   * execution is reached that is already mirrored unchanged — everything older
   * is already in sync.
   */
  private async syncExecutions(instanceId: number, client: N8nApiClient) {
    const execRepo = this.db.getRepository('n8nExecutionHistory');
    let cursor: string | undefined;
    let maxStartedAt: Date | null = null;

    for (let page = 0; page < MAX_EXEC_PAGES_PER_SYNC; page++) {
      const res = await client.listExecutions({ limit: EXEC_PAGE_SIZE, cursor, includeData: false });
      const items: N8nExecutionItem[] = res?.data || [];
      if (items.length === 0) break;

      const ids = items.map((e) => String(e.id));
      const existingRows = await execRepo.find({ filter: { instanceId, executionId: { $in: ids } } });
      const existingMap = new Map<string, (typeof existingRows)[number]>();
      for (const row of existingRows) {
        existingMap.set(String(row.get('executionId')), row);
      }

      let reachedSynced = false;
      for (const item of items) {
        const normalized = this.normalizeExecution(instanceId, item);
        if (!normalized.startedAt) continue;

        const started = new Date(normalized.startedAt);
        if (!maxStartedAt || started > maxStartedAt) maxStartedAt = started;

        const existing = existingMap.get(normalized.executionId);
        if (existing) {
          const unchanged =
            existing.get('status') === normalized.status &&
            Boolean(existing.get('finished')) === normalized.finished &&
            Math.abs(Number(existing.get('durationMs')) - normalized.durationMs) < 1;
          if (unchanged) {
            reachedSynced = true;
            break;
          }
          const oldExec = this.rowToExecution(existing);
          await this.applyRollupDelta(instanceId, oldExec, -1);
          await this.applyWorkflowStatsDelta(instanceId, oldExec, -1, false);
          await this.applyRollupDelta(instanceId, normalized, 1);
          await this.applyWorkflowStatsDelta(instanceId, normalized, 1, false);
          await execRepo.update({
            filter: { id: existing.get('id') },
            values: {
              status: normalized.status,
              finished: normalized.finished,
              stoppedAt: normalized.stoppedAt,
              durationMs: normalized.durationMs,
              workflowName: normalized.workflowName,
            },
          });
        } else {
          await execRepo.create({ values: normalized });
          await this.applyRollupDelta(instanceId, normalized, 1);
          await this.applyWorkflowStatsDelta(instanceId, normalized, 1, true);
        }
      }

      if (reachedSynced) break;
      cursor = res.nextCursor;
      if (!cursor) break;
    }

    if (maxStartedAt) {
      await this.db.getRepository('n8nInstances').update({
        filter: { id: instanceId },
        values: { lastExecSyncAt: maxStartedAt },
      });
    }
  }

  private async applyRollupDelta(instanceId: number, exec: NormalizedExecution, sign: 1 | -1) {
    if (!exec.startedAt) return;
    const bucket = hourBucketOf(new Date(exec.startedAt));
    const repo = this.db.getRepository('n8nExecutionHourly');

    let row = await repo.findOne({ filter: { instanceId, workflowId: exec.workflowId, hourBucket: bucket } });
    if (!row) {
      row = await repo.create({
        values: { instanceId, workflowId: exec.workflowId, workflowName: exec.workflowName, hourBucket: bucket },
      });
    }

    const statusField = exec.status;
    const values: Record<string, unknown> = {
      [statusField]: Math.max(0, Number(row.get(statusField)) + sign),
      finishedCount: Math.max(0, Number(row.get('finishedCount')) + (exec.finished ? sign : 0)),
      totalDurationMs: Math.max(0, Number(row.get('totalDurationMs')) + (exec.finished ? sign * exec.durationMs : 0)),
    };
    if (exec.workflowName) values.workflowName = exec.workflowName;
    await repo.update({ filter: { id: row.get('id') }, values });
  }

  private async applyWorkflowStatsDelta(instanceId: number, exec: NormalizedExecution, sign: 1 | -1, isNew: boolean) {
    const repo = this.db.getRepository('n8nWorkflowStats');

    let row = await repo.findOne({ filter: { instanceId, workflowId: exec.workflowId } });
    if (!row) {
      row = await repo.create({ values: { instanceId, workflowId: exec.workflowId, name: exec.workflowName } });
    }

    const values: Record<string, unknown> = {
      totalRuns: Math.max(0, Number(row.get('totalRuns')) + (isNew ? sign : 0)),
      successCount: Math.max(0, Number(row.get('successCount')) + (exec.status === 'success' ? sign : 0)),
      errorCount: Math.max(0, Number(row.get('errorCount')) + (exec.status === 'error' ? sign : 0)),
      finishedCount: Math.max(0, Number(row.get('finishedCount')) + (exec.finished ? sign : 0)),
      totalDurationMs: Math.max(0, Number(row.get('totalDurationMs')) + (exec.finished ? sign * exec.durationMs : 0)),
    };

    if (sign === 1 && exec.startedAt) {
      const lastRunAt = row.get('lastRunAt') as string | Date | null;
      if (!lastRunAt || new Date(exec.startedAt) >= new Date(lastRunAt)) {
        values.lastRunAt = exec.startedAt;
        values.lastStatus = exec.status;
        values.lastExecutionId = exec.executionId;
      }
    }
    if (exec.workflowName) values.name = exec.workflowName;
    await repo.update({ filter: { id: row.get('id') }, values });
  }

  private async maybeSyncWorkflows(
    instanceId: number,
    client: N8nApiClient,
    instance: { get: (key: string) => unknown },
  ) {
    const intervalSec = Number(instance.get('collectIntervalSeconds')) || DEFAULT_INTERVAL_SECONDS;
    const gap = Math.max(WORKFLOW_SYNC_MIN_GAP_MS, intervalSec * WORKFLOW_SYNC_EVERY_N_INTERVALS * 1000);
    const last = instance.get('lastWorkflowSyncAt') as string | Date | null;
    if (last && Date.now() - new Date(last).getTime() < gap) return;

    const workflows: Array<{ id: string | number; name?: string; active?: boolean }> =
      (await client.listAllWorkflows()) || [];
    const statsRepo = this.db.getRepository('n8nWorkflowStats');
    let activeCount = 0;

    for (const wf of workflows) {
      const workflowId = String(wf.id);
      if (wf.active) activeCount++;
      const row = await statsRepo.findOne({ filter: { instanceId, workflowId } });
      if (row) {
        await statsRepo.update({
          filter: { id: row.get('id') },
          values: { name: wf.name, active: Boolean(wf.active) },
        });
      } else {
        await statsRepo.create({
          values: { instanceId, workflowId, name: wf.name || `#${workflowId}`, active: Boolean(wf.active) },
        });
      }
    }

    await this.db.getRepository('n8nInstances').update({
      filter: { id: instanceId },
      values: { totalWorkflows: workflows.length, activeWorkflows: activeCount, lastWorkflowSyncAt: new Date() },
    });
  }

  private async checkWorkers(instanceId: number, instance: { get: (key: string) => unknown }) {
    const workers = instance.get('workers') as Array<{ hostname?: string; url?: string }> | null;
    if (!Array.isArray(workers) || workers.length === 0) return;

    const results = await Promise.all(
      workers.map(async (w) => {
        const url = (w.url || '').replace(/\/+$/, '');
        if (!url) return null;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5000);
          const res = await fetch(`${url}/healthz`, {
            headers: { Accept: 'application/json' },
            signal: controller.signal,
          });
          clearTimeout(timer);
          return {
            workerId: w.hostname,
            hostname: w.hostname,
            status: res.ok ? 'online' : 'error',
            lastSeen: res.ok ? new Date().toISOString() : null,
          };
        } catch {
          return { workerId: w.hostname, hostname: w.hostname, status: 'offline', lastSeen: null };
        }
      }),
    );

    await this.db.getRepository('n8nInstances').update({
      filter: { id: instanceId },
      values: { workerStatus: results.filter(Boolean), lastWorkerCheckAt: new Date() },
    });
  }

  private async prune(instanceId: number, retentionDays: number) {
    const now = Date.now();
    const cutoff = new Date(now - retentionDays * DAY_MS);
    const hourlyCutoff = new Date(now - Math.max(retentionDays, HOURLY_RETENTION_DAYS) * DAY_MS);

    await this.db.getRepository('n8nMetricsSnapshots').destroy({ filter: { instanceId, timestamp: { $lt: cutoff } } });
    await this.db.getRepository('n8nExecutionHistory').destroy({ filter: { instanceId, startedAt: { $lt: cutoff } } });
    await this.db
      .getRepository('n8nExecutionHourly')
      .destroy({ filter: { instanceId, hourBucket: { $lt: hourlyCutoff } } });
  }

  private async evaluateAlerts(instanceId: number, snapshot: Record<string, unknown>) {
    const repo = this.db.getRepository('n8nAlertRules');
    const rules = await repo.find({ filter: { instanceId, enabled: true } });

    for (const rule of rules) {
      const metric = rule.get('metric') as string;
      const operator = rule.get('operator') as string;
      const threshold = rule.get('threshold') as number;
      const windowMinutes = rule.get('windowMinutes') as number;
      const lastTriggered = rule.get('lastTriggeredAt') as Date | null;

      if (lastTriggered) {
        const elapsed = (Date.now() - new Date(lastTriggered).getTime()) / 60000;
        if (elapsed < windowMinutes) continue;
      }

      const value = snapshot[metric];
      if (typeof value !== 'number') continue;

      let breached = false;
      switch (operator) {
        case '>':
          breached = value > threshold;
          break;
        case '<':
          breached = value < threshold;
          break;
        case '>=':
          breached = value >= threshold;
          break;
        case '<=':
          breached = value <= threshold;
          break;
        case '==':
          breached = value === threshold;
          break;
      }

      if (!breached) continue;

      const alertMsg = `[n8n Alert] ${rule.get('name')}: ${metric} ${operator} ${threshold} (current: ${value})`;
      const channel = rule.get('notifyChannel') as string;

      if (channel === 'webhook') {
        const webhookUrl = rule.get('webhookUrl') as string;
        if (webhookUrl) {
          fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alert: rule.get('name'), metric, value, threshold, operator, instanceId }),
          }).catch((err) => {
            this.logger.warn(`[plugin-n8n] Alert webhook failed: ${err}`);
          });
        }
      } else {
        this.logger.warn(alertMsg);
      }

      await repo.update({ filter: { id: rule.get('id') }, values: { lastTriggeredAt: new Date() } });
    }
  }
}
