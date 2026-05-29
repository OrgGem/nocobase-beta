/**
 * Job actions
 *
 * - list:    GET /odata/Jobs
 * - get:     GET /odata/Jobs({id})
 * - start:   POST /odata/Jobs/UiPath.Server.Configuration.OData.StartJobs
 * - stop:    POST /odata/Jobs/UiPath.Server.Configuration.OData.StopJobs  (soft stop)
 * - kill:    POST /odata/Jobs({id})/UiPath.Server.Configuration.OData.StopJob  (hard kill)
 * - restart: POST /odata/Jobs/UiPath.Server.Configuration.OData.RestartJob
 */

import type { Context, Next } from '@nocobase/actions';
import type { PluginUiPathOrchestratorServer } from '../plugin';
import { handleError, extractFolderContext, extractODataFilter } from './shared';

export function createJobActions(plugin: PluginUiPathOrchestratorServer) {
  return {
    list: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const query = extractODataFilter(ctx.action.params);

        // Default: most recent first
        if (!query.$orderby) query.$orderby = 'CreationTime desc';

        const data = await client.get('/odata/Jobs', { query, folder });
        ctx.body = {
          data: data.value || data,
          count: data['@odata.count'],
        };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    get: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        ctx.body = await client.get(`/odata/Jobs(${filterByTk})`, { folder });
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    start: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, values } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);

        // values should contain: { releaseKey, strategy?, robotIds?, inputArguments?, ... }
        const startInfo: any = {
          ReleaseKey: values.releaseKey,
          Strategy: values.strategy || 'ModernJobsCount',
          JobsCount: values.jobsCount || 1,
          RuntimeType: values.runtimeType,
          InputArguments: values.inputArguments
            ? typeof values.inputArguments === 'string'
              ? values.inputArguments
              : JSON.stringify(values.inputArguments)
            : undefined,
        };

        if (values.robotIds && Array.isArray(values.robotIds)) {
          startInfo.Strategy = 'Specific';
          startInfo.RobotIds = values.robotIds;
        }

        // Clean undefined values
        Object.keys(startInfo).forEach((k) => {
          if (startInfo[k] === undefined) delete startInfo[k];
        });

        const result = await client.post(
          '/odata/Jobs/UiPath.Server.Configuration.OData.StartJobs',
          { startInfo },
          { folder },
        );

        // Audit log
        await plugin.auditLog(ctx, {
          action: 'start_job',
          resourceType: 'job',
          resourceId: values.releaseKey,
          instanceId: Number(instanceId),
          folder,
          details: { releaseKey: values.releaseKey, strategy: startInfo.Strategy },
        });

        ctx.body = result;
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    stop: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk, values = {} } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const jobIds = Array.isArray(values.jobIds) ? values.jobIds : [values.jobId ?? filterByTk].filter(Boolean);

        if (!jobIds.length) {
          throw new Error('Job ID is required');
        }

        // Soft stop: POST /odata/Jobs/UiPath.Server.Configuration.OData.StopJobs
        // Body: { jobIds: [id1, id2], strategy: 'SoftStop' }
        const result = await client.post(
          '/odata/Jobs/UiPath.Server.Configuration.OData.StopJobs',
          {
            jobIds: jobIds.map(Number),
            strategy: values.strategy || 'SoftStop',
          },
          { folder },
        );

        await plugin.auditLog(ctx, {
          action: 'stop_job',
          resourceType: 'job',
          resourceId: jobIds.join(','),
          instanceId: Number(instanceId),
          folder,
          details: { strategy: values.strategy || 'SoftStop' },
        });

        ctx.body = result;
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    kill: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);

        // Hard kill via StopJobs with Kill strategy
        const result = await client.post(
          '/odata/Jobs/UiPath.Server.Configuration.OData.StopJobs',
          { jobIds: [Number(filterByTk)], strategy: 'Kill' },
          { folder },
        );

        await plugin.auditLog(ctx, {
          action: 'kill_job',
          resourceType: 'job',
          resourceId: String(filterByTk),
          instanceId: Number(instanceId),
          folder,
        });

        ctx.body = result;
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    restart: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);

        const result = await client.post(
          '/odata/Jobs/UiPath.Server.Configuration.OData.RestartJob',
          { jobId: Number(filterByTk) },
          { folder },
        );

        await plugin.auditLog(ctx, {
          action: 'restart_job',
          resourceType: 'job',
          resourceId: String(filterByTk),
          instanceId: Number(instanceId),
          folder,
        });

        ctx.body = result;
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
