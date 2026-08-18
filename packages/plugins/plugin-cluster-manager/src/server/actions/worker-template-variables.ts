import type { Context } from '@nocobase/actions';
import type { StackConfig } from '../orchestrator/types';
import {
  encryptWorkerTemplateSecret,
  isForbiddenWorkerTemplateOverride,
  isWorkerTemplateEnvironmentKey,
  maskWorkerTemplateVariable,
  resolveWorkerTemplate,
  type WorkerTemplateScope,
  type WorkerTemplateVariable,
} from '../orchestrator/worker-template';

type ModelLike = {
  get(key: string): unknown;
  toJSON(): Record<string, unknown>;
};

function toVariable(model: ModelLike): WorkerTemplateVariable {
  return model.toJSON() as unknown as WorkerTemplateVariable;
}

function getValues(ctx: Context): Record<string, unknown> {
  return (ctx.action.params.values || ctx.action.params) as Record<string, unknown>;
}

function parseScope(value: unknown): WorkerTemplateScope {
  if (value === 'global' || value === 'stack') {
    return value;
  }
  throw new Error('scope must be global or stack');
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parseSort(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function validateValues(values: Record<string, unknown>, existing?: WorkerTemplateVariable): WorkerTemplateVariable {
  const key = String(values.key || existing?.key || '')
    .trim()
    .toUpperCase();
  const scope = parseScope(values.scope || existing?.scope || 'global');
  const stackId = values.stackId ?? existing?.stackId ?? null;
  if (!isWorkerTemplateEnvironmentKey(key)) {
    throw new Error('key must be an uppercase environment variable name');
  }
  if (scope === 'stack' && !stackId) {
    throw new Error('stackId is required for stack-scoped variables');
  }
  if (scope === 'global' && stackId) {
    throw new Error('global variables cannot have stackId');
  }
  if (isForbiddenWorkerTemplateOverride(key, scope)) {
    throw new Error(`${key} is enforced by Cluster Manager and cannot be overridden`);
  }

  const secret = parseBoolean(values.secret, existing?.secret || false);
  const replacementValue = values.value;
  return {
    key,
    value: secret ? undefined : replacementValue == null ? existing?.value || '' : String(replacementValue),
    secretValue:
      secret && replacementValue !== undefined && replacementValue !== ''
        ? encryptWorkerTemplateSecret(String(replacementValue))
        : existing?.secretValue,
    valueType: secret
      ? 'secret'
      : (String(values.valueType || existing?.valueType || 'string') as WorkerTemplateVariable['valueType']),
    category: String(values.category || existing?.category || 'custom'),
    scope,
    stackId: scope === 'stack' ? Number(stackId) : null,
    description: String(values.description ?? existing?.description ?? ''),
    defaultValue: String(values.defaultValue ?? existing?.defaultValue ?? ''),
    required: parseBoolean(values.required, existing?.required || false),
    systemManaged: existing?.systemManaged || false,
    overridable: parseBoolean(values.overridable, existing?.overridable ?? true),
    secret,
    enabled: parseBoolean(values.enabled, existing?.enabled ?? true),
    sort: parseSort(values.sort ?? existing?.sort),
  };
}

async function findVariables(ctx: Context): Promise<WorkerTemplateVariable[]> {
  const repo = ctx.db.getRepository('workerTemplateVariables');
  const rows = (await repo.find({ sort: ['scope', 'stackId', 'sort', 'key'] })) as ModelLike[];
  return rows.map(toVariable);
}

async function resolveForStack(ctx: Context, stackId: unknown) {
  if (!stackId) {
    ctx.throw(400, 'stackId is required');
  }
  const stacks = ctx.db.getRepository('orchestratorStacks');
  const model = (await stacks.findOne({ filterByTk: String(stackId) })) as ModelLike | null;
  if (!model) {
    ctx.throw(404, `Stack #${stackId} not found`);
  }
  const variables = await findVariables(ctx);
  const result = resolveWorkerTemplate({
    stack: model.toJSON() as unknown as StackConfig,
    variables,
    inheritedEnv: {
      CLUSTER_MANAGER_WORKER_READY_URL: process.env.CLUSTER_MANAGER_WORKER_READY_URL,
      CLUSTER_MANAGER_WORKER_IMAGE: process.env.CLUSTER_MANAGER_WORKER_IMAGE,
    },
    fallbackReadyUrl: process.env.CLUSTER_MANAGER_WORKER_READY_URL,
  });
  // Keys whose resolved values came from an encrypted secret variable.
  const secretKeys = new Set(
    variables.filter((variable) => variable.secret && variable.enabled !== false).map((variable) => variable.key),
  );
  return { result, secretKeys };
}

const SECRET_MASK = '••••••••';

/**
 * Never return decrypted secret values through the API. Mask by the secret
 * flag (exact) and by the conservative key-name heuristic (defense in depth).
 */
function maskResolvedEnvVars(envVars: Record<string, string>, secretKeys: Set<string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(envVars).map(([key, value]) => [
      key,
      secretKeys.has(key) || /PASSWORD|SECRET|TOKEN|KEY/i.test(key) ? SECRET_MASK : value,
    ]),
  );
}

export const workerTemplateVariableActions = {
  async list(ctx: Context, next: () => Promise<void>) {
    ctx.body = { data: (await findVariables(ctx)).map(maskWorkerTemplateVariable) };
    await next();
  },

  async upsert(ctx: Context, next: () => Promise<void>) {
    const values = getValues(ctx);
    const repo = ctx.db.getRepository('workerTemplateVariables');
    const id = values.id;
    const existingModel = id ? ((await repo.findOne({ filterByTk: String(id) })) as ModelLike | null) : null;
    const existing = existingModel ? toVariable(existingModel) : undefined;
    if (existing?.systemManaged && !['WORKER_MODE', 'WORKER_READY_URL', 'WORKER_IMAGE'].includes(existing.key)) {
      ctx.throw(403, `${existing.key} is system-managed`);
    }

    let variable: WorkerTemplateVariable;
    try {
      variable = validateValues(values, existing);
    } catch (error) {
      ctx.throw(400, error instanceof Error ? error.message : String(error));
      return;
    }
    const duplicate = await repo.findOne({
      filter: { key: variable.key, scope: variable.scope, stackId: variable.stackId },
    });
    if (duplicate && String(duplicate.get('id')) !== String(id || '')) {
      ctx.throw(409, `Variable ${variable.key} already exists in this scope`);
    }
    const stored = existingModel
      ? await repo.update({ filterByTk: String(id), values: variable })
      : await repo.create({ values: variable });
    ctx.body = { data: maskWorkerTemplateVariable(toVariable(stored as ModelLike)) };
    await next();
  },

  async destroy(ctx: Context, next: () => Promise<void>) {
    const values = getValues(ctx);
    const id = values.id || ctx.action.params.filterByTk;
    const repo = ctx.db.getRepository('workerTemplateVariables');
    const existing = id ? ((await repo.findOne({ filterByTk: id })) as ModelLike | null) : null;
    if (!existing) {
      ctx.throw(404, 'Worker template variable not found');
    }
    if (existing.get('systemManaged')) {
      ctx.throw(403, `${String(existing.get('key'))} is system-managed`);
    }
    await repo.destroy({ filterByTk: id });
    ctx.body = { success: true };
    await next();
  },

  async preview(ctx: Context, next: () => Promise<void>) {
    const { result, secretKeys } = await resolveForStack(ctx, getValues(ctx).stackId || ctx.action.params.stackId);
    ctx.body = {
      data: {
        ...result,
        envVars: maskResolvedEnvVars(result.envVars, secretKeys),
      },
    };
    await next();
  },

  async resolved(ctx: Context, next: () => Promise<void>) {
    const { result, secretKeys } = await resolveForStack(ctx, getValues(ctx).stackId || ctx.action.params.stackId);
    ctx.body = {
      data: {
        ...result,
        envVars: maskResolvedEnvVars(result.envVars, secretKeys),
      },
    };
    await next();
  },
};
