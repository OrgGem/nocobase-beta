import type { Context, Next } from '@nocobase/actions';
import type { PluginN8nServer } from '../plugin';

function handleError(ctx: Context, error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown error';
  ctx.status = 400;
  ctx.body = { errors: [{ message }] };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const DASHBOARD_RANGES: Record<string, { ms: number; bucket: 'hour' | 'day' }> = {
  '24h': { ms: DAY_MS, bucket: 'hour' },
  '7d': { ms: 7 * DAY_MS, bucket: 'day' },
  '30d': { ms: 30 * DAY_MS, bucket: 'day' },
};

const HISTORY_RANGES: Record<string, number> = {
  '1h': HOUR_MS,
  '6h': 6 * HOUR_MS,
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
};

const MAX_HISTORY_POINTS = 360;

function hourBucketOf(date: Date): Date {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d;
}

function dayBucketOf(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function createMonitoringActions(plugin: PluginN8nServer) {
  const resolveInstanceId = async (instanceId?: number | string): Promise<number | null> => {
    return instanceId ? Number(instanceId) : await plugin.getDefaultInstanceId();
  };

  return {
    /** Stored health state — no request to n8n. */
    health: async (ctx: Context, next: Next) => {
      try {
        const resolvedId = await resolveInstanceId(ctx.action.params.instanceId);
        const instance = await plugin.db.getRepository('n8nInstances').findOne({ filter: { id: resolvedId } });
        ctx.body = {
          status: instance?.get('lastHealthStatus') || 'unknown',
          latencyMs: instance?.get('lastHealthLatency') || 0,
          lastCollectedAt: instance?.get('lastCollectedAt') || null,
        };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    /** Latest collected metrics snapshot — no request to n8n. */
    metrics: async (ctx: Context, next: Next) => {
      try {
        const resolvedId = await resolveInstanceId(ctx.action.params.instanceId);
        const row = await plugin.db
          .getRepository('n8nMetricsSnapshots')
          .findOne({ filter: { instanceId: resolvedId }, sort: ['-timestamp'] });
        ctx.body = row ? row.toJSON() : null;
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    /** Metrics history from DB with range + downsampling. */
    metricsHistory: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, range } = ctx.action.params;
        const resolvedId = await resolveInstanceId(instanceId);
        const rangeMs = HISTORY_RANGES[range as string] || HOUR_MS;
        const since = new Date(Date.now() - rangeMs);

        const rows = await plugin.db.getRepository('n8nMetricsSnapshots').find({
          filter: { instanceId: resolvedId, timestamp: { $gte: since } },
          sort: ['timestamp'],
        });

        let data = rows.map((r: { toJSON: () => Record<string, unknown> }) => r.toJSON());
        if (data.length > MAX_HISTORY_POINTS) {
          const step = Math.ceil(data.length / MAX_HISTORY_POINTS);
          const sampled = data.filter((_, i) => i % step === 0);
          if (sampled[sampled.length - 1] !== data[data.length - 1]) {
            sampled.push(data[data.length - 1]);
          }
          data = sampled;
        }

        ctx.body = { data };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    /** Worker status collected in the background — no request to n8n/workers. */
    workers: async (ctx: Context, next: Next) => {
      try {
        const resolvedId = await resolveInstanceId(ctx.action.params.instanceId);
        const instance = await plugin.db.getRepository('n8nInstances').findOne({ filter: { id: resolvedId } });
        const workers = instance?.get('workerStatus');
        ctx.body = Array.isArray(workers) ? workers : [];
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    /** Trigger an immediate collection cycle (lock-guarded). */
    collectNow: async (ctx: Context, next: Next) => {
      try {
        const resolvedId = await resolveInstanceId(ctx.action.params.instanceId);
        const triggered = resolvedId ? await plugin.collector.requestCollect(resolvedId) : false;
        ctx.body = { triggered };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    /**
     * Dashboard served entirely from collected data:
     * hourly rollups + executions mirror + workflow stats + snapshots.
     */
    dashboard: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, range } = ctx.action.params;
        const resolvedId = await resolveInstanceId(instanceId);
        if (!resolvedId) {
          throw new Error('No n8n instance configured. Please add an n8n instance first.');
        }

        const instance = await plugin.db.getRepository('n8nInstances').findOne({ filter: { id: resolvedId } });
        if (!instance) {
          throw new Error('n8n instance not found.');
        }

        const { ms: rangeMs, bucket } = DASHBOARD_RANGES[range as string] || DASHBOARD_RANGES['24h'];
        const since = new Date(Date.now() - rangeMs);
        const bucketMs = bucket === 'hour' ? HOUR_MS : DAY_MS;
        const firstBucket = bucket === 'hour' ? hourBucketOf(since) : dayBucketOf(since);

        const [hourlyRows, snapshots, recentFailureRows, workflowStatsRows] = await Promise.all([
          plugin.db
            .getRepository('n8nExecutionHourly')
            .find({ filter: { instanceId: resolvedId, hourBucket: { $gte: firstBucket } } }),
          plugin.db
            .getRepository('n8nMetricsSnapshots')
            .find({ filter: { instanceId: resolvedId, timestamp: { $gte: since } }, sort: ['timestamp'] }),
          plugin.db.getRepository('n8nExecutionHistory').find({
            filter: { instanceId: resolvedId, status: 'error' },
            sort: ['-startedAt'],
            limit: 10,
          }),
          plugin.db.getRepository('n8nWorkflowStats').find({ filter: { instanceId: resolvedId } }),
        ]);

        // Pre-populate buckets so empty periods render as zeros
        const buckets = new Map<number, { label: string; success: number; error: number; running: number }>();
        for (let t = firstBucket.getTime(); t <= Date.now(); t += bucketMs) {
          const d = new Date(t);
          const label =
            bucket === 'hour'
              ? `${d.getHours().toString().padStart(2, '0')}:00`
              : `${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
          buckets.set(t, { label, success: 0, error: 0, running: 0 });
        }

        let success = 0;
        let error = 0;
        let running = 0;
        let waiting = 0;
        let finishedCount = 0;
        let totalDurationMs = 0;

        for (const row of hourlyRows) {
          const rowSuccess = Number(row.get('success')) || 0;
          const rowError = Number(row.get('error')) || 0;
          const rowRunning = Number(row.get('running')) || 0;
          const rowWaiting = Number(row.get('waiting')) || 0;

          success += rowSuccess;
          error += rowError;
          running += rowRunning;
          waiting += rowWaiting;
          finishedCount += Number(row.get('finishedCount')) || 0;
          totalDurationMs += Number(row.get('totalDurationMs')) || 0;

          const bucketTime =
            bucket === 'hour'
              ? hourBucketOf(new Date(row.get('hourBucket') as Date)).getTime()
              : dayBucketOf(new Date(row.get('hourBucket') as Date)).getTime();
          const target = buckets.get(bucketTime);
          if (target) {
            target.success += rowSuccess;
            target.error += rowError;
            target.running += rowRunning + rowWaiting;
          }
        }

        const total = success + error + running + waiting;
        const healthyCount = snapshots.filter((s) => s.get('healthStatus') === 'healthy').length;
        const latestSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

        const workflowStats = workflowStatsRows
          .map((w) => {
            const wfFinished = Number(w.get('finishedCount')) || 0;
            const wfTotalDuration = Number(w.get('totalDurationMs')) || 0;
            return {
              workflowId: w.get('workflowId'),
              name: w.get('name'),
              active: w.get('active'),
              totalRuns: Number(w.get('totalRuns')) || 0,
              successCount: Number(w.get('successCount')) || 0,
              errorCount: Number(w.get('errorCount')) || 0,
              successRate:
                wfFinished > 0 ? Math.round(((Number(w.get('successCount')) || 0) / wfFinished) * 100) : null,
              avgDuration: wfFinished > 0 ? Math.round(wfTotalDuration / wfFinished) : null,
              lastRunAt: w.get('lastRunAt'),
              lastStatus: w.get('lastStatus'),
              lastExecutionId: w.get('lastExecutionId'),
            };
          })
          .sort((a, b) => {
            const ta = a.lastRunAt ? new Date(a.lastRunAt).getTime() : 0;
            const tb = b.lastRunAt ? new Date(b.lastRunAt).getTime() : 0;
            return tb - ta;
          })
          .slice(0, 200);

        ctx.body = {
          health: {
            status: instance.get('lastHealthStatus') || 'unknown',
            latencyMs: instance.get('lastHealthLatency') || 0,
          },
          collector: {
            lastCollectedAt: instance.get('lastCollectedAt'),
            intervalSeconds: instance.get('collectIntervalSeconds') || 60,
            collectEnabled: Boolean(instance.get('collectEnabled')),
            metricsEnabled: Boolean(instance.get('metricsEnabled')),
            lastExecSyncAt: instance.get('lastExecSyncAt'),
          },
          workflows: {
            total: Number(instance.get('totalWorkflows')) || 0,
            active: Number(instance.get('activeWorkflows')) || 0,
          },
          executions: {
            total,
            success,
            error,
            running,
            waiting,
            successRate: total > 0 ? Math.round((success / total) * 100) : 0,
            avgDuration: finishedCount > 0 ? Math.round(totalDurationMs / finishedCount) : 0,
          },
          uptimePct: snapshots.length > 0 ? Math.round((healthyCount / snapshots.length) * 100) : null,
          queue: latestSnapshot
            ? {
                waiting: Number(latestSnapshot.get('queueWaiting')) || 0,
                active: Number(latestSnapshot.get('queueActive')) || 0,
                throughput: Number(latestSnapshot.get('queueThroughput')) || 0,
                failRate: Number(latestSnapshot.get('queueFailRate')) || 0,
              }
            : null,
          bucket,
          history: Array.from(buckets.values()),
          recentFailures: recentFailureRows.map((e) => ({
            id: e.get('executionId'),
            workflowId: e.get('workflowId'),
            workflowName: e.get('workflowName'),
            status: e.get('status'),
            mode: e.get('mode'),
            startedAt: e.get('startedAt'),
            stoppedAt: e.get('stoppedAt'),
            durationMs: e.get('durationMs'),
          })),
          workflowStats,
        };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
