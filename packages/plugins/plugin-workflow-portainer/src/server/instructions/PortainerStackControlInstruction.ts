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
import { buildEffectiveStackEnv } from '../../shared/env';
import type { PortainerContainerSummary, PortainerStackControlConfig, StackControlAction } from '../../shared/types';
import { assertPositiveInt, summarizeContainersHealth, toStackDetail } from '../services/PortainerClient';
import { formatFailureResult, resolvePortainerInstance, runPortainerWorkflowTask } from './helpers';

const numOrVar = Joi.alternatives().try(Joi.number(), Joi.string().allow(''), Joi.allow(null));

export async function executePortainerControl(
  app: Parameters<typeof resolvePortainerInstance>[0],
  config: PortainerStackControlConfig,
  signal?: AbortSignal,
) {
  const startedAt = new Date();
  const instance = await resolvePortainerInstance(app, config.instanceId ?? null);
  const stackId = assertPositiveInt(config.stackId ?? undefined, 'Stack ID');
  const action: StackControlAction = config.action === 'start' || config.action === 'stop' ? config.action : 'inspect';

  let rawStack = await instance.client.getRawStack(stackId, signal);
  const hasExplicitEndpoint =
    config.endpointId !== null && typeof config.endpointId !== 'undefined' && String(config.endpointId).trim() !== '';
  const endpointId = hasExplicitEndpoint
    ? assertPositiveInt(config.endpointId ?? undefined, 'Environment (Endpoint) ID')
    : assertPositiveInt(rawStack.EndpointId, 'Stack Endpoint ID');

  if (action === 'start') {
    rawStack = await instance.client.startStack(stackId, endpointId, signal);
    rawStack = await instance.client.waitForStackSettlement(stackId, rawStack, {
      timeoutMs: config.timeoutMs ? Number(config.timeoutMs) : instance.defaultTimeoutMs,
      signal,
    });
  } else if (action === 'stop') {
    rawStack = await instance.client.stopStack(stackId, endpointId, signal);
    rawStack = await instance.client.waitForStackSettlement(stackId, rawStack, {
      timeoutMs: config.timeoutMs ? Number(config.timeoutMs) : instance.defaultTimeoutMs,
      signal,
    });
  }

  const detail = toStackDetail(rawStack);
  const { maskedEnv } = buildEffectiveStackEnv({
    existingEnv: detail.env,
    strategy: 'merge',
  });

  let containers: PortainerContainerSummary[] = [];
  try {
    containers = await instance.client.listStackContainers(endpointId, detail.name, signal);
  } catch {
    containers = [];
  }

  const summary = summarizeContainersHealth(containers);
  const stackStatus = Number(rawStack.Status ?? detail.status ?? 1);
  const healthy =
    action === 'stop' ? summary.runningCount === 0 : containers.length > 0 ? summary.healthy : stackStatus === 1;

  const finishedAt = new Date();
  return {
    ok: true,
    action,
    instanceId: instance.id,
    instanceName: instance.name,
    endpointId,
    stackId,
    stackName: detail.name,
    stackType: detail.isGitStack ? ('git' as const) : ('compose' as const),
    stackStatus,
    gitReference: detail.gitReference ?? null,
    healthy,
    runningCount: summary.runningCount,
    totalCount: summary.totalCount,
    containers,
    currentEnv: maskedEnv,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
  };
}

export class PortainerStackControlInstruction extends Instruction {
  configSchema = Joi.object({
    instanceId: numOrVar,
    endpointId: numOrVar,
    stackId: numOrVar,
    action: Joi.string().valid('inspect', 'start', 'stop').default('inspect'),
    timeoutMs: numOrVar,
    ignoreFail: Joi.boolean().default(false),
  }).unknown(true);

  async run(node: FlowNodeModel, prevJob: JobModel, processor: Processor, options?: { signal?: AbortSignal }) {
    const config = processor.getParsedValue(node.config ?? {}, node.id) as PortainerStackControlConfig;
    return runPortainerWorkflowTask({
      workflow: this.workflow,
      node,
      prevJob,
      processor,
      ignoreFail: config.ignoreFail,
      signal: options?.signal,
      execute: (signal) => executePortainerControl(this.workflow.app, config, signal),
    });
  }

  async resume(node: FlowNodeModel, job: JobModel) {
    const config = (node.config ?? {}) as PortainerStackControlConfig;
    if (config.ignoreFail) {
      job.set('status', JOB_STATUS.RESOLVED);
    }
    return job;
  }

  async test(config: PortainerStackControlConfig) {
    const startedAt = new Date();
    try {
      const result = await executePortainerControl(this.workflow.app, config);
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

export default PortainerStackControlInstruction;
