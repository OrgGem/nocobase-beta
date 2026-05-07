/**
 * UiPath AI Tools
 *
 * Optional tools for NocoBase AI plugin integration.
 * Enables AI agents to query job status, logs, queue backlog, and trigger operations.
 */

import type { ToolsOptions } from '@nocobase/ai';

const escapeODataString = (value: string) => value.replace(/'/g, "''");

export function createUiPathTools(getApiClient: (instanceId?: number) => Promise<any>): ToolsOptions[] {
  return [
    {
      scope: 'GENERAL',
      execution: 'backend',
      defaultPermission: 'ASK',
      introduction: {
        title: 'UiPath: Get Failed Jobs',
        about: 'List recent failed/faulted jobs from UiPath Orchestrator.',
      },
      definition: {
        name: 'uipath_get_failed_jobs',
        description:
          'Get recent failed (Faulted/Stopped) jobs from UiPath Orchestrator. Use when user asks about job failures or errors.',
        schema: {
          type: 'object',
          properties: {
            top: { type: 'number', description: 'Max results (default 10)' },
            instanceId: { type: 'number', description: 'Optional instance ID' },
          },
        },
      },
      invoke: async (_ctx, args) => {
        const client = await getApiClient(args.instanceId);
        const data = await client.get('/odata/Jobs', {
          query: {
            $filter: "State eq 'Faulted' or State eq 'Stopped'",
            $top: args.top || 10,
            $orderby: 'CreationTime desc',
            $select: 'Id,Key,State,ReleaseName,Info,StartTime,EndTime,HostMachineName',
          },
        });
        return { status: 'success', content: JSON.stringify(data.value || []) };
      },
    },
    {
      scope: 'GENERAL',
      execution: 'backend',
      defaultPermission: 'ASK',
      introduction: {
        title: 'UiPath: Summarize Robot Logs',
        about: 'Get error robot logs for a specific job or time range.',
      },
      definition: {
        name: 'uipath_summarize_logs',
        description: 'Get error/warning robot logs. Use when user asks about robot errors or wants to debug a job.',
        schema: {
          type: 'object',
          properties: {
            jobKey: { type: 'string', description: 'Optional job key to filter logs' },
            level: { type: 'string', description: 'Log level filter (Error, Warn, Info)' },
            top: { type: 'number', description: 'Max results (default 20)' },
            instanceId: { type: 'number', description: 'Optional instance ID' },
          },
        },
      },
      invoke: async (_ctx, args) => {
        const client = await getApiClient(args.instanceId);
        const filters: string[] = [];
        if (args.jobKey) filters.push(`JobKey eq '${escapeODataString(args.jobKey)}'`);
        if (args.level) filters.push(`Level eq '${escapeODataString(args.level)}'`);
        if (filters.length === 0) filters.push("Level eq 'Error'");
        const data = await client.get('/odata/RobotLogs', {
          query: {
            $filter: filters.join(' and '),
            $top: args.top || 20,
            $orderby: 'TimeStamp desc',
          },
        });
        return { status: 'success', content: JSON.stringify(data.value || []) };
      },
    },
    {
      scope: 'GENERAL',
      execution: 'backend',
      defaultPermission: 'ASK',
      introduction: {
        title: 'UiPath: Queue Backlog',
        about: 'Check queue item backlog and failed transactions.',
      },
      definition: {
        name: 'uipath_queue_backlog',
        description:
          'Get queue items with status New/InProgress/Failed. Use when user asks about queue health or transaction failures.',
        schema: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'Filter status (New, InProgress, Failed)' },
            top: { type: 'number', description: 'Max results (default 20)' },
            instanceId: { type: 'number', description: 'Optional instance ID' },
          },
        },
      },
      invoke: async (_ctx, args) => {
        const client = await getApiClient(args.instanceId);
        const status = args.status || 'Failed';
        const data = await client.get('/odata/QueueItems', {
          query: {
            $filter: `Status eq '${escapeODataString(status)}'`,
            $top: args.top || 20,
            $orderby: 'CreationTime desc',
          },
        });
        return { status: 'success', content: JSON.stringify(data.value || []) };
      },
    },
    {
      scope: 'CUSTOM',
      execution: 'backend',
      defaultPermission: 'ASK',
      introduction: {
        title: 'UiPath: Stop/Kill Job',
        about: 'Stop or kill a running UiPath job.',
      },
      definition: {
        name: 'uipath_stop_job',
        description: 'Stop or kill a running UiPath job. Use when user wants to stop a running automation.',
        schema: {
          type: 'object',
          properties: {
            jobId: { type: 'number', description: 'Job ID to stop' },
            strategy: { type: 'string', description: 'SoftStop or Kill (default SoftStop)' },
            instanceId: { type: 'number', description: 'Optional instance ID' },
          },
          required: ['jobId'],
        },
      },
      invoke: async (_ctx, args) => {
        const client = await getApiClient(args.instanceId);
        const result = await client.post('/odata/Jobs/UiPath.Server.Configuration.OData.StopJobs', {
          jobIds: [args.jobId],
          strategy: args.strategy || 'SoftStop',
        });
        return { status: 'success', content: JSON.stringify(result) };
      },
    },
  ];
}
