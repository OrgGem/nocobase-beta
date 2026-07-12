import type { Context, Next } from '@nocobase/actions';
import type { PluginUiPathOrchestratorServer } from '../plugin';
import type { FolderContext } from '../services/types';
import { handleError, extractFolderContext } from './shared';
import {
  buildContainsFilter,
  buildDateRangeFilter,
  buildEqualsFilter,
  combineODataFilters,
  odataString,
  uniqueStrings,
} from '../utils/odata';

type Row = Record<string, unknown>;

function modelToRow(model: unknown): Row {
  if (!model || typeof model !== 'object') return {};
  const maybeModel = model as { toJSON?: () => Row; dataValues?: Row };
  if (maybeModel.toJSON) return maybeModel.toJSON();
  return maybeModel.dataValues || (model as Row);
}

function asArray(value: unknown): Row[] {
  const body = value && typeof value === 'object' ? (value as Row) : {};
  if (Array.isArray(body.value))
    return body.value.filter((item): item is Row => Boolean(item) && typeof item === 'object');
  return Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === 'object') : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function toIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function durationSeconds(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  return Math.max(0, Math.round((endMs - startMs) / 1000));
}

function countBy(rows: Row[], field: string): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const key = String(row[field] || 'Unknown');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function buildStepFolder(step: Row, fallback?: FolderContext): FolderContext | undefined {
  const folderId = asNumber(step.folderId) ?? fallback?.folderId;
  const folderKey = asString(step.folderKey) || fallback?.folderKey;
  const folderPath = asString(step.folderPath) || fallback?.folderPath;
  return folderId || folderKey || folderPath ? { folderId, folderKey, folderPath } : fallback;
}

function deriveStepStatus(jobs: Row[], queueItems: Row[], logs: Row[]): string {
  if (jobs.some((job) => ['Faulted', 'Stopped'].includes(String(job.State)))) return 'faulted';
  if (queueItems.some((item) => ['Failed', 'Abandoned'].includes(String(item.Status)))) return 'faulted';
  if (logs.some((log) => ['Error', 'Fatal'].includes(String(log.Level)))) return 'faulted';
  if (jobs.some((job) => ['Running', 'Pending'].includes(String(job.State)))) return 'running';
  if (queueItems.some((item) => ['New', 'InProgress'].includes(String(item.Status)))) return 'running';
  if (jobs.length || queueItems.length || logs.length) return 'healthy';
  return 'idle';
}

export function createProcessMonitorActions(plugin: PluginUiPathOrchestratorServer) {
  return {
    snapshot: async (ctx: Context, next: Next) => {
      try {
        const { processId, instanceId, from, to } = ctx.action.params;
        if (!processId) {
          throw new Error('processId is required');
        }

        const processRecord = await plugin.db.getRepository('uipathMonitorProcesses').findOne({
          filterByTk: processId,
        });
        const process = modelToRow(processRecord);
        if (!Object.keys(process).length) {
          throw new Error('Monitor process not found');
        }

        const resolvedInstanceId = instanceId || process.instanceId;
        const client = await plugin.getApiClient(resolvedInstanceId as string | number | undefined);
        const fallbackFolder = extractFolderContext(ctx.action.params);
        const defaultWindowMinutes = asNumber(process.defaultWindowMinutes) || 1440;
        const toTime = toIso(to) || new Date().toISOString();
        const fromTime =
          toIso(from) || new Date(new Date(toTime).getTime() - defaultWindowMinutes * 60_000).toISOString();

        const stepRecords = await plugin.db.getRepository('uipathMonitorProcessSteps').find({
          filter: { processId, enabled: true },
          sort: ['stepOrder'],
        });
        const steps = stepRecords.map(modelToRow);
        const stepSnapshots: Array<{
          status: string;
          counts: {
            jobs: number;
            queues: number;
            logs: number;
            slaBreaches: number;
            jobsByState?: Record<string, number>;
            queuesByStatus?: Record<string, number>;
            logsByLevel?: Record<string, number>;
          };
          [key: string]: unknown;
        }> = [];

        for (const step of steps) {
          const folder = buildStepFolder(step, fallbackFolder);
          const releaseKey = asString(step.releaseKey);
          const processName = asString(step.processName) || asString(step.name);
          const queueDefinitionId = asNumber(step.queueDefinitionId);
          const queueName = asString(step.queueName);
          const referencePattern = asString(step.referencePattern);

          const jobFilter = combineODataFilters([
            releaseKey ? `ReleaseKey eq ${odataString(releaseKey)}` : undefined,
            processName ? buildContainsFilter('ReleaseName', processName) : undefined,
            buildDateRangeFilter('CreationTime', { from: fromTime, to: toTime }),
          ]);
          const jobs = jobFilter
            ? asArray(
                await client
                  .get('/odata/Jobs', {
                    query: { $top: 100, $filter: jobFilter, $orderby: 'CreationTime desc' },
                    folder,
                  })
                  .catch((error: unknown) => {
                    plugin.app.logger.warn(`[plugin-uipath] Process monitor jobs query failed: ${String(error)}`);
                    return { value: [] };
                  }),
              )
            : [];
          const jobKeys = uniqueStrings(jobs.map((job) => asString(job.Key)));

          const queueFilter = combineODataFilters([
            buildEqualsFilter('QueueDefinitionId', queueDefinitionId || null),
            referencePattern ? buildContainsFilter('Reference', referencePattern) : undefined,
            buildDateRangeFilter('CreationTime', { from: fromTime, to: toTime }),
          ]);
          let queueItems = queueFilter
            ? asArray(
                await client
                  .get('/odata/QueueItems', {
                    query: { $top: 100, $filter: queueFilter, $orderby: 'CreationTime desc' },
                    folder,
                  })
                  .catch((error: unknown) => {
                    plugin.app.logger.warn(
                      `[plugin-uipath] Process monitor queue items query failed: ${String(error)}`,
                    );
                    return { value: [] };
                  }),
              )
            : [];

          if (!queueItems.length && queueName) {
            const definitionData = await client
              .get('/odata/QueueDefinitions', {
                query: { $top: 10, $filter: `Name eq ${odataString(queueName)}` },
                folder,
              })
              .catch((error: unknown) => {
                plugin.app.logger.warn(
                  `[plugin-uipath] Process monitor queue definitions query failed: ${String(error)}`,
                );
                return { value: [] };
              });
            const definitionIds = asArray(definitionData)
              .map((row) => asNumber(row.Id))
              .filter((id): id is number => Boolean(id));
            if (definitionIds.length) {
              queueItems = asArray(
                await client
                  .get('/odata/QueueItems', {
                    query: {
                      $top: 100,
                      $filter: combineODataFilters([
                        definitionIds.map((id) => `QueueDefinitionId eq ${id}`).join(' or '),
                        buildDateRangeFilter('CreationTime', { from: fromTime, to: toTime }),
                      ]),
                      $orderby: 'CreationTime desc',
                    },
                    folder,
                  })
                  .catch((error: unknown) => {
                    plugin.app.logger.warn(
                      `[plugin-uipath] Process monitor queue fallback query failed: ${String(error)}`,
                    );
                    return { value: [] };
                  }),
              );
            }
          }

          const logFilter = combineODataFilters([
            jobKeys.length ? jobKeys.map((key) => `JobKey eq ${odataString(key)}`).join(' or ') : undefined,
            !jobKeys.length && processName ? buildContainsFilter('ProcessName', processName) : undefined,
            buildDateRangeFilter('TimeStamp', { from: fromTime, to: toTime }),
          ]);
          const logs = logFilter
            ? asArray(
                await client
                  .get('/odata/RobotLogs', {
                    query: { $top: 100, $filter: logFilter, $orderby: 'TimeStamp desc' },
                    folder,
                  })
                  .catch((error: unknown) => {
                    plugin.app.logger.warn(`[plugin-uipath] Process monitor logs query failed: ${String(error)}`);
                    return { value: [] };
                  }),
              )
            : [];

          const slaSeconds = asNumber(step.slaSeconds);
          const slaBreaches = [
            ...jobs
              .map((job) => ({
                type: 'job',
                id: job.Id,
                durationSeconds: durationSeconds(asString(job.StartTime), asString(job.EndTime)),
              }))
              .filter((item) => slaSeconds && item.durationSeconds !== null && item.durationSeconds > slaSeconds),
            ...queueItems
              .map((item) => ({
                type: 'queueItem',
                id: item.Id,
                durationSeconds: durationSeconds(asString(item.StartProcessing), asString(item.EndProcessing)),
              }))
              .filter((item) => slaSeconds && item.durationSeconds !== null && item.durationSeconds > slaSeconds),
          ];

          stepSnapshots.push({
            step,
            folder,
            status: deriveStepStatus(jobs, queueItems, logs),
            jobs,
            queueItems,
            logs,
            counts: {
              jobs: jobs.length,
              queues: queueItems.length,
              logs: logs.length,
              jobsByState: countBy(jobs, 'State'),
              queuesByStatus: countBy(queueItems, 'Status'),
              logsByLevel: countBy(logs, 'Level'),
              slaBreaches: slaBreaches.length,
            },
            slaBreaches,
            correlationLinks: {
              jobKeys,
              queueItemIds: queueItems.map((item) => item.Id),
            },
          });
        }

        const summary = stepSnapshots.reduce(
          (acc, step) => {
            acc.jobs += step.counts.jobs;
            acc.queues += step.counts.queues;
            acc.logs += step.counts.logs;
            acc.slaBreaches += step.counts.slaBreaches;
            if (step.status === 'faulted') acc.faultedSteps += 1;
            if (step.status === 'running') acc.runningSteps += 1;
            return acc;
          },
          {
            steps: stepSnapshots.length,
            jobs: 0,
            queues: 0,
            logs: 0,
            slaBreaches: 0,
            faultedSteps: 0,
            runningSteps: 0,
          },
        );

        ctx.body = {
          process,
          window: { from: fromTime, to: toTime },
          summary,
          steps: stepSnapshots,
        };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
