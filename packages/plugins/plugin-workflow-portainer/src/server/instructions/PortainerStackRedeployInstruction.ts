/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import Joi from 'joi';
import { Instruction, JOB_STATUS, type FlowNodeModel, type JobModel, type Processor } from '@nocobase/plugin-workflow';
import { buildEffectiveStackEnv, normalizeGitReference } from '../../shared/env';
import type { PortainerContainerSummary, PortainerStackRedeployConfig } from '../../shared/types';
import {
  assertPositiveInt,
  clampTimeoutMs,
  PortainerApiError,
  summarizeContainersHealth,
  toStackDetail,
  type RawPortainerStack,
} from '../services/PortainerClient';
import {
  formatFailureResult,
  resolvePortainerInstance,
  runPortainerWorkflowTask,
  type ResolvedPortainerInstance,
} from './helpers';

const numOrVar = Joi.alternatives().try(Joi.number(), Joi.string().allow(''), Joi.allow(null));

function resolveGitAuthPayload(stack: RawPortainerStack, instance: ResolvedPortainerInstance) {
  const stackAuth = stack.GitConfig?.Authentication;
  const stackCredId = Number(stackAuth?.GitCredentialID ?? 0);
  const effectiveCredId = stackCredId > 0 ? stackCredId : instance.gitCredentialId;

  if (effectiveCredId && effectiveCredId > 0) {
    return {
      repositoryAuthentication: true,
      repositoryGitCredentialID: effectiveCredId,
      ...(stackAuth?.Username ? { repositoryUsername: String(stackAuth.Username) } : {}),
    };
  }

  if (instance.gitAccessToken) {
    return {
      repositoryAuthentication: true,
      repositoryUsername: String(stackAuth?.Username || instance.gitUsername || 'oauth2'),
      repositoryPassword: instance.gitAccessToken,
    };
  }

  if (stackAuth?.Username) {
    return {
      repositoryAuthentication: true,
      repositoryUsername: String(stackAuth.Username),
    };
  }

  return {
    repositoryAuthentication: false,
  };
}

export async function executePortainerRedeploy(
  app: Parameters<typeof resolvePortainerInstance>[0],
  config: PortainerStackRedeployConfig,
  signal?: AbortSignal,
) {
  const startedAt = new Date();
  const instance = await resolvePortainerInstance(app, config.instanceId ?? null);
  const timeoutMs = clampTimeoutMs(config.timeoutMs, instance.defaultTimeoutMs);
  const mode = config.mode === 'webhook' ? 'webhook' : 'stack';

  if (mode === 'webhook') {
    await instance.client.triggerWebhook(config.webhookId ?? '', config.webhookTag, { timeoutMs, signal });
    const finishedAt = new Date();
    return {
      ok: true,
      instanceId: instance.id,
      instanceName: instance.name,
      endpointId: null,
      stackId: null,
      stackName: null,
      stackType: 'webhook' as const,
      stackStatus: 1,
      gitReference: null,
      webhookTag: config.webhookTag ? String(config.webhookTag).trim() : null,
      appliedEnv: {},
      appliedEnvCount: 0,
      runningCount: 0,
      totalCount: 0,
      healthy: true,
      containers: [] as PortainerContainerSummary[],
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    };
  }

  const stackId = assertPositiveInt(config.stackId ?? undefined, 'Stack ID');
  const rawStack = await instance.client.getRawStack(stackId, signal);
  const stackDetail = toStackDetail(rawStack);

  const hasExplicitEndpoint =
    config.endpointId !== null && typeof config.endpointId !== 'undefined' && String(config.endpointId).trim() !== '';
  const endpointId = hasExplicitEndpoint
    ? assertPositiveInt(config.endpointId ?? undefined, 'Environment (Endpoint) ID')
    : assertPositiveInt(rawStack.EndpointId, 'Stack Endpoint ID');

  const { env, maskedEnv } = buildEffectiveStackEnv({
    existingEnv: stackDetail.env,
    strategy: config.envStrategy ?? 'merge',
    dynamicEnv: config.dynamicEnv,
    envText: config.envText,
    envPairs: config.envPairs,
  });

  const prune = Boolean(config.prune);
  const repullImage = Boolean(config.repullImage);
  let updatedStack: RawPortainerStack;
  let gitReferenceUsed: string | null = null;

  if (stackDetail.isGitStack) {
    gitReferenceUsed = normalizeGitReference(config.gitReference, stackDetail.gitReference);
    const gitAuth = resolveGitAuthPayload(rawStack, instance);
    updatedStack = await instance.client.redeployGitStack(
      stackId,
      endpointId,
      {
        env,
        prune,
        repullImage,
        repositoryReferenceName: gitReferenceUsed,
        ...gitAuth,
      },
      { timeoutMs, signal },
    );
  } else {
    const stackFileContent = await instance.client.getStackFile(stackId, signal);
    if (!stackFileContent.trim()) {
      throw new PortainerApiError('Portainer stack file content is empty; cannot update non-Git stack', {
        code: 'EMPTY_STACK_FILE',
      });
    }
    updatedStack = await instance.client.updateComposeStack(
      stackId,
      endpointId,
      {
        stackFileContent,
        env,
        prune,
        repullImage,
      },
      { timeoutMs, signal },
    );
  }

  updatedStack = await instance.client.waitForStackSettlement(stackId, updatedStack, { timeoutMs, signal });

  const stackName = String(updatedStack?.Name ?? rawStack.Name ?? '');
  let containers: PortainerContainerSummary[] = [];
  try {
    containers = await instance.client.listStackContainers(endpointId, stackName, signal);
  } catch {
    containers = [];
  }
  const health = summarizeContainersHealth(containers);
  const finishedAt = new Date();

  return {
    ok: true,
    instanceId: instance.id,
    instanceName: instance.name,
    endpointId,
    stackId,
    stackName,
    stackType: stackDetail.isGitStack ? ('git' as const) : ('compose' as const),
    stackStatus: Number(updatedStack?.Status ?? rawStack.Status ?? 1),
    gitReference: gitReferenceUsed,
    appliedEnv: maskedEnv,
    appliedEnvCount: env.length,
    runningCount: health.runningCount,
    totalCount: health.totalCount,
    healthy: containers.length > 0 ? health.healthy : true,
    containers,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
  };
}

export class PortainerStackRedeployInstruction extends Instruction {
  configSchema = Joi.object({
    instanceId: numOrVar,
    mode: Joi.string().valid('stack', 'webhook').default('stack'),
    endpointId: numOrVar,
    stackId: numOrVar,
    webhookId: Joi.string().allow('', null),
    webhookTag: Joi.string().allow('', null),
    gitReference: Joi.string().allow('', null),
    repullImage: Joi.boolean().default(false),
    prune: Joi.boolean().default(false),
    envStrategy: Joi.string().valid('merge', 'replace').default('merge'),
    dynamicEnv: Joi.any(),
    envText: Joi.string().allow('', null),
    envPairs: Joi.array().items(
      Joi.object({
        name: Joi.string().allow('', null),
        value: Joi.any(),
        secret: Joi.boolean(),
      }).unknown(true),
    ),
    timeoutMs: numOrVar,
    ignoreFail: Joi.boolean().default(false),
  }).unknown(true);

  async run(node: FlowNodeModel, prevJob: JobModel, processor: Processor, options?: { signal?: AbortSignal }) {
    const config = processor.getParsedValue(node.config ?? {}, node.id) as PortainerStackRedeployConfig;
    return runPortainerWorkflowTask({
      workflow: this.workflow,
      node,
      prevJob,
      processor,
      ignoreFail: config.ignoreFail,
      signal: options?.signal,
      execute: (signal) => executePortainerRedeploy(this.workflow.app, config, signal),
    });
  }

  async resume(node: FlowNodeModel, job: JobModel) {
    const config = (node.config ?? {}) as PortainerStackRedeployConfig;
    if (config.ignoreFail) {
      job.set('status', JOB_STATUS.RESOLVED);
    }
    return job;
  }

  async test(config: PortainerStackRedeployConfig) {
    const startedAt = new Date();
    try {
      const result = await executePortainerRedeploy(this.workflow.app, config);
      return {
        status: JOB_STATUS.RESOLVED,
        result,
      };
    } catch (error) {
      return {
        status: config.ignoreFail ? JOB_STATUS.RESOLVED : JOB_STATUS.FAILED,
        result: formatFailureResult(error, startedAt),
      };
    }
  }
}

export default PortainerStackRedeployInstruction;
