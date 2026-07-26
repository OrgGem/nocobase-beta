import { Migration } from '@nocobase/server';
import { WORKER_TEMPLATE_DEFAULTS, type WorkerTemplateVariable } from '../orchestrator/worker-template';

type ModelLike = {
  get(key: string): unknown;
};

export default class extends Migration {
  on = 'afterLoad';

  async up() {
    const variables = this.db.getRepository('workerTemplateVariables');
    for (const value of WORKER_TEMPLATE_DEFAULTS) {
      const existing = await variables.findOne({
        filter: { key: value.key, scope: 'global', stackId: null },
      });
      if (!existing) {
        await variables.create({ values: value });
      }
    }

    const stacks = this.db.getRepository('orchestratorStacks');
    const rows = (await stacks.find()) as ModelLike[];
    for (const stack of rows) {
      const stackId = stack.get('id');
      const envVars = stack.get('envVars');
      if (!stackId || !envVars || typeof envVars !== 'object' || Array.isArray(envVars)) {
        continue;
      }

      for (const [key, value] of Object.entries(envVars as Record<string, unknown>)) {
        const existing = await variables.findOne({ filter: { key, scope: 'stack', stackId } });
        if (!existing) {
          const variable: Omit<WorkerTemplateVariable, 'id'> = {
            key,
            value: value == null ? '' : String(value),
            valueType: 'string',
            category: 'custom',
            scope: 'stack',
            stackId: Number(stackId),
            description: 'Migrated from orchestratorStacks.envVars.',
            enabled: true,
          };
          await variables.create({ values: variable });
        }
      }
    }
  }
}
