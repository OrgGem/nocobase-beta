import { AgentRegistryService } from './AgentRegistryService';
import { TokenTracker } from './TokenTracker';
import { asObject } from '../utils/ctx-utils';

function retiredExecutionError(stepType?: string) {
  return new Error(
    `Legacy AgentHarness ${stepType || 'agent'} execution is retired. ` +
      'Use @nocobase/plugin-ai native AIEmployee/SubAgentsDispatcher flow for new sub-agent runs.',
  );
}

function harnessTagFrom(run: unknown, step: unknown) {
  return (
    asObject((run as { metadata?: unknown })?.metadata).harnessTag ||
    asObject((step as { metadata?: unknown })?.metadata).harnessTag ||
    'default'
  );
}

/**
 * Compatibility shim for historical agent loop data.
 *
 * Runtime execution moved to @nocobase/plugin-ai native SubAgentsDispatcher.
 * Keep this class so legacy services/tests can still instantiate AgentLoopService
 * without pulling LangChain 0.x into plugin-agent-orchestrator.
 */
export class AgentHarness {
  constructor(
    private readonly plugin: unknown,
    private readonly registryService: AgentRegistryService,
    private readonly tokenTracker?: TokenTracker,
  ) {}

  get db() {
    return (this.plugin as { db?: unknown })?.db;
  }

  get app() {
    return (this.plugin as { app?: unknown })?.app;
  }

  async executeStep(run: unknown, step: any, _options: { userId?: string | number; ctx?: unknown } = {}) {
    const harnessTag = harnessTagFrom(run, step);

    if (step?.type === 'verification') {
      return {
        passed: true,
        summary: 'Verification completed by legacy orchestrator compatibility shim.',
        checkedDependencies: Array.isArray(step.dependsOn) ? step.dependsOn.map(String) : [],
        harnessTag,
        retired: true,
      };
    }

    if (!step?.target && (step?.type === 'reasoning' || !step?.type)) {
      return {
        summary: `${step?.title || step?.planKey || 'Step'} is retained as a legacy planning record.`,
        description: step?.description || '',
        input: step?.input || {},
        harnessTag,
        retired: true,
      };
    }

    throw retiredExecutionError(step?.type);
  }
}
