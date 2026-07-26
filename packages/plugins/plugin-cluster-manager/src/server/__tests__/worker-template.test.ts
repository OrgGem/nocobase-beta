import type { StackConfig } from '../orchestrator/types';
import {
  encryptWorkerTemplateSecret,
  maskWorkerTemplateVariable,
  resolveWorkerTemplate,
  WORKER_TEMPLATE_DEFAULTS,
  type WorkerTemplateVariable,
} from '../orchestrator/worker-template';

const stack: StackConfig = {
  id: 7,
  name: 'app-workers',
  adapter: 'docker',
  image: '',
  replicas: 0,
  desiredReplicas: 1,
  enabled: true,
};

function defaults(): WorkerTemplateVariable[] {
  return WORKER_TEMPLATE_DEFAULTS.map((value, index) => ({ ...value, id: index + 1 }));
}

describe('worker template resolver', () => {
  it('defaults every worker to all queues and enforces the worker identity', () => {
    const resolved = resolveWorkerTemplate({
      stack: { ...stack, envVars: { APP_ROLE: 'app', APP_NODE_ROLE: 'main' } },
      variables: defaults(),
      inheritedEnv: { CLUSTER_MANAGER_WORKER_READY_URL: 'http://migration-leader:13000/api/app:getInfo' },
    });

    expect(resolved.envVars.APP_ROLE).toBe('worker');
    expect(resolved.envVars.APP_NODE_ROLE).toBe('worker');
    expect(resolved.envVars.WORKER_MODE).toBe('*');
    expect(resolved.envVars.WORKER_READY_URL).toBe('http://migration-leader:13000/api/app:getInfo');
    expect(resolved.envVars.LOGGER_BASE_PATH).toBe('/app/nocobase/storage/logs/app-workers');
  });

  it('allows a stack mode to narrow the global all-queue default', () => {
    const resolved = resolveWorkerTemplate({
      stack: { ...stack, workerMode: 'workflow.pendingExecution' },
      variables: defaults(),
      fallbackReadyUrl: 'http://leader/api/app:getInfo',
    });

    expect(resolved.envVars.WORKER_MODE).toBe('workflow:process');
  });

  it('uses collection variables before legacy envVars and masks secrets in responses', () => {
    process.env.ENCRYPTION_FIELD_KEY = 'worker-template-test-key';
    const variables: WorkerTemplateVariable[] = [
      ...defaults(),
      {
        id: 99,
        key: 'CUSTOM_SETTING',
        value: 'new-value',
        scope: 'stack',
        stackId: 7,
        enabled: true,
      },
      {
        id: 100,
        key: 'API_TOKEN',
        secret: true,
        secretValue: encryptWorkerTemplateSecret('top-secret'),
        scope: 'stack',
        stackId: 7,
        enabled: true,
      },
    ];
    const resolved = resolveWorkerTemplate({
      stack: { ...stack, envVars: { CUSTOM_SETTING: 'legacy-value', LEGACY_ONLY: 'kept' } },
      variables,
      fallbackReadyUrl: 'http://leader/api/app:getInfo',
    });

    expect(resolved.envVars.CUSTOM_SETTING).toBe('new-value');
    expect(resolved.envVars.LEGACY_ONLY).toBe('kept');
    expect(resolved.envVars.API_TOKEN).toBe('top-secret');
    expect(maskWorkerTemplateVariable(variables[variables.length - 1])).toMatchObject({
      value: '••••••••',
      secretValue: undefined,
      masked: true,
    });
  });

  it('fails closed when no readiness endpoint is configured', () => {
    expect(() =>
      resolveWorkerTemplate({
        stack,
        variables: defaults().filter((variable) => variable.key !== 'WORKER_READY_URL'),
      }),
    ).toThrow('no readiness URL');
  });

  it('ignores stale image and command records instead of starting an unverified bootstrap', () => {
    const resolved = resolveWorkerTemplate({
      stack: { ...stack, image: 'nocobase/nocobase:2.1.6-full', command: 'yarn nocobase upgrade' },
      variables: defaults(),
      inheritedEnv: {
        CLUSTER_MANAGER_WORKER_READY_URL: 'http://leader/api/app:getInfo',
        CLUSTER_MANAGER_WORKER_IMAGE: 'nocobase/nocobase:2.1.30-full',
      },
    });

    expect(resolved.image).toBe('nocobase/nocobase:2.1.30-full');
    expect(resolved.warnings).toHaveLength(2);
  });
});
