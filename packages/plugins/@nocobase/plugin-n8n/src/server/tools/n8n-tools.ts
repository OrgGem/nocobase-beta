import type { ToolsOptions } from '@nocobase/ai';

export function createN8nTools(getApiClient: (instanceId?: number) => Promise<any>): ToolsOptions[] {
  return [
    {
      scope: 'GENERAL',
      execution: 'backend',
      defaultPermission: 'ASK',
      introduction: {
        title: 'n8n: List Workflows',
        about: 'Search and list n8n workflows by name.',
      },
      definition: {
        name: 'n8n_list_workflows',
        description:
          'List or search n8n workflows. Use this when user asks about their workflows, automations, or wants to find a specific workflow.',
        schema: {
          type: 'object',
          properties: {
            search: { type: 'string', description: 'Optional search term to filter workflows by name' },
            instanceId: { type: 'number', description: 'Optional n8n instance ID. Uses default if omitted.' },
          },
        },
      },
      invoke: async (ctx, args) => {
        const client = await getApiClient(args.instanceId);
        let workflows = await client.listAllWorkflows();
        if (args.search) {
          const q = args.search.toLowerCase();
          workflows = workflows.filter((w) => w.name?.toLowerCase().includes(q));
        }
        const summary = workflows.map((w) => ({
          id: w.id,
          name: w.name,
          active: w.active,
          updatedAt: w.updatedAt,
        }));
        return { status: 'success', content: JSON.stringify(summary) };
      },
    },
    {
      scope: 'GENERAL',
      execution: 'backend',
      defaultPermission: 'ASK',
      introduction: {
        title: 'n8n: Get Execution',
        about: 'Get detailed information about a specific n8n execution.',
      },
      definition: {
        name: 'n8n_get_execution',
        description:
          'Get details of a specific n8n workflow execution. Use this when user asks about execution status, results, or errors.',
        schema: {
          type: 'object',
          properties: {
            executionId: { type: 'string', description: 'The execution ID to look up' },
            instanceId: { type: 'number', description: 'Optional n8n instance ID' },
          },
          required: ['executionId'],
        },
      },
      invoke: async (ctx, args) => {
        const client = await getApiClient(args.instanceId);
        const execution = await client.getExecution(args.executionId);
        return { status: 'success', content: JSON.stringify(execution) };
      },
    },
    {
      scope: 'GENERAL',
      execution: 'backend',
      defaultPermission: 'ASK',
      introduction: {
        title: 'n8n: Analyze Error',
        about: 'Analyze errors from a failed n8n execution.',
      },
      definition: {
        name: 'n8n_analyze_error',
        description:
          'Analyze a failed n8n execution to extract error details from each node. Use when user asks why a workflow failed.',
        schema: {
          type: 'object',
          properties: {
            executionId: { type: 'string', description: 'The failed execution ID' },
            instanceId: { type: 'number', description: 'Optional n8n instance ID' },
          },
          required: ['executionId'],
        },
      },
      invoke: async (ctx, args) => {
        const client = await getApiClient(args.instanceId);
        const execution = await client.getExecution(args.executionId);
        const errors: Array<{ nodeName: string; message: string; type: string }> = [];

        if (execution?.data?.resultData?.runData) {
          for (const [nodeName, runs] of Object.entries<any>(execution.data.resultData.runData)) {
            for (const run of Array.isArray(runs) ? runs : [runs]) {
              if (run?.error) {
                errors.push({
                  nodeName,
                  message: run.error.message || String(run.error),
                  type: run.error.name || 'Error',
                });
              }
            }
          }
        }

        return {
          status: 'success',
          content: JSON.stringify({
            executionId: execution.id,
            workflowName: execution.workflowData?.name,
            status: execution.status,
            errors,
            startedAt: execution.startedAt,
            stoppedAt: execution.stoppedAt,
          }),
        };
      },
    },
    {
      scope: 'CUSTOM',
      execution: 'backend',
      defaultPermission: 'ASK',
      introduction: {
        title: 'n8n: Trigger Workflow',
        about: 'Trigger an n8n workflow via webhook.',
      },
      definition: {
        name: 'n8n_trigger_workflow',
        description:
          'Trigger an n8n workflow by its webhook path. Use when user wants to run or trigger a specific automation.',
        schema: {
          type: 'object',
          properties: {
            webhookPath: { type: 'string', description: 'Webhook path or full URL' },
            data: { type: 'object', description: 'Optional JSON data to send' },
            instanceId: { type: 'number', description: 'Optional n8n instance ID' },
          },
          required: ['webhookPath'],
        },
      },
      invoke: async (ctx, args) => {
        const client = await getApiClient(args.instanceId);
        const result = await client.triggerWebhook(args.webhookPath, args.data);
        return { status: 'success', content: JSON.stringify(result) };
      },
    },
    {
      scope: 'GENERAL',
      execution: 'backend',
      defaultPermission: 'ASK',
      introduction: {
        title: 'n8n: Get Metrics',
        about: 'Get current performance metrics from n8n instance.',
      },
      definition: {
        name: 'n8n_get_metrics',
        description:
          'Get current performance metrics (CPU, memory, queue stats) from an n8n instance. Use when user asks about n8n performance or health.',
        schema: {
          type: 'object',
          properties: {
            instanceId: { type: 'number', description: 'Optional n8n instance ID' },
          },
        },
      },
      invoke: async (ctx, args) => {
        const client = await getApiClient(args.instanceId);
        const metrics = await client.getMetricsSnapshot();
        return { status: 'success', content: JSON.stringify(metrics) };
      },
    },
  ];
}
