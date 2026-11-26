// SPDX-License-Identifier: Apache-2.0

import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { Transaction } from '@nocobase/database';
import type { LLMProvider, LLMProviderMeta, LLMProviderOptions } from '@nocobase/plugin-ai';
import {
  EXECUTION_STATUS,
  getExecutionLockKey,
  Instruction,
  isWorkflowTimeoutError,
  JOB_STATUS,
  type FlowNodeModel,
  type IJob,
  type JobModel,
  type Processor,
} from '@nocobase/plugin-workflow';
import { isRecord, type ID } from './contracts';
import { withOwnedRequest, type LockedRequest } from './ownership';
import { reviewTestContext } from './manual-test';

type AIPlugin = { aiManager: { llmProviders: Map<string, LLMProviderMeta> } };
type BackgroundHandle = ReturnType<Processor['createBackgroundAbortHandle']>;
type ProviderOutcome = { ok: true; response: unknown } | { ok: false; error: unknown };
type StructuredOutputConfig = {
  schema?: unknown;
  name?: string;
  description?: string;
  strict?: boolean;
};

const STRICT_UNSUPPORTED_SCHEMA_KEYS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
]);

function sanitizeStrictJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeStrictJsonSchema(item));
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (STRICT_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    result[key] = sanitizeStrictJsonSchema(nested);
  }
  return result;
}

function unwrapSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (typeof schema.name === 'string' && isRecord(schema.parameters) && typeof schema.type !== 'string') {
    return schema.parameters;
  }
  return schema;
}

function stripTextResponseFormat(model: unknown): void {
  if (!isRecord(model)) return;
  const kwargs = model.modelKwargs;
  if (isRecord(kwargs)) {
    if (isRecord(kwargs.response_format) && kwargs.response_format.type === 'text') {
      delete kwargs.response_format;
    }
    if (isRecord(kwargs.text) && isRecord(kwargs.text.format) && kwargs.text.format.type === 'text') {
      delete kwargs.text.format;
      if (Object.keys(kwargs.text).length === 0) delete kwargs.text;
    }
  }
  if (isRecord(model.completions)) stripTextResponseFormat(model.completions);
  if (isRecord(model.responses)) stripTextResponseFormat(model.responses);
}

/** Normalize provider structured-output config so LangChain receives raw JSON Schema without text-format overrides. */
export function configureProviderStructuredOutput(provider: LLMProvider, providerName: string): void {
  const model = (provider as unknown as { chatModel?: unknown }).chatModel;
  stripTextResponseFormat(model);
  if (providerName === 'google-genai') return;

  const isResponsesModel = isRecord(model) && model.useResponsesApi === true;
  provider.getStructuredOutputOptions = (structuredOutput: StructuredOutputConfig | undefined) => {
    const rawSchema = structuredOutput?.schema;
    if (!isRecord(rawSchema)) return undefined;
    const unwrapped = unwrapSchema(rawSchema);
    const name = typeof structuredOutput?.name === 'string' && structuredOutput.name ? structuredOutput.name : 'review';
    const strict = structuredOutput?.strict === true;

    if (providerName === 'anthropic' || (providerName === 'deepseek' && !isResponsesModel)) {
      return {
        schema: sanitizeStrictJsonSchema(unwrapped),
        options: { includeRaw: true, name, method: 'functionCalling' },
      };
    }

    if (providerName === 'ollama') {
      return {
        schema: sanitizeStrictJsonSchema(unwrapped),
        options: { includeRaw: true, name, method: 'jsonSchema' },
      };
    }

    return {
      schema: strict ? sanitizeStrictJsonSchema(unwrapped) : unwrapped,
      options: {
        includeRaw: true,
        name,
        method: 'jsonSchema',
        ...(strict ? { strict: true } : {}),
      },
    };
  };
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

function parseJsonFromContent(content: unknown): unknown {
  const text = contentToText(content).trim();
  if (!text) return undefined;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  const candidate = fenced ? fenced[1].trim() : text;
  try {
    const parsed: unknown = JSON.parse(candidate);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function extractStructuredResult(response: unknown) {
  const wrapper = isRecord(response) ? response : {};
  const raw = isRecord(wrapper.raw) ? wrapper.raw : wrapper;
  const structuredContent = wrapper.parsed != null ? wrapper.parsed : parseJsonFromContent(raw.content);
  const content =
    typeof raw.content === 'string' && raw.content.trim()
      ? raw.content
      : structuredContent !== undefined
        ? JSON.stringify(structuredContent)
        : raw.content;
  return {
    id: raw.id,
    content,
    additionalKwargs: raw.additional_kwargs,
    responseMetadata: raw.response_metadata,
    toolCalls: raw.tool_calls,
    structuredContent,
  };
}

function redactErrorText(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|glpat-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password|key)\s*[:=]\s*)[^\s,&"']+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

export function formatProviderError(error: unknown, provider?: LLMProvider): string {
  let rawMessage = '';
  try {
    const parsed = provider?.parseResponseError?.(error);
    if (typeof parsed === 'string' && parsed.trim()) rawMessage = parsed;
  } catch {
    // Fall back to the raw error message below.
  }
  if (!rawMessage) {
    if (error instanceof Error && error.message) rawMessage = error.message;
    else if (isRecord(error) && typeof error.message === 'string') rawMessage = error.message;
    else rawMessage = String(error ?? '');
  }
  const status = isRecord(error) && typeof error.status === 'number' ? error.status : undefined;
  const prefixed = status && !rawMessage.includes(String(status)) ? `HTTP ${status}: ${rawMessage}` : rawMessage;
  return redactErrorText(prefixed);
}

export function parseTextMessages(value: unknown, schema?: unknown): BaseMessage[] {
  if (!Array.isArray(value) || !value.length) throw new Error('Review LLM messages are required');
  const messages = value.map((message: unknown) => {
    if (!isRecord(message)) throw new Error('Invalid review LLM message');
    if (message.role === 'system' || message.role === 'assistant') {
      if (typeof message.message !== 'string') throw new Error('Invalid review LLM message');
      return message.role === 'system' ? new SystemMessage(message.message) : new AIMessage(message.message);
    }
    if (message.role !== 'user' || !Array.isArray(message.content)) throw new Error('Invalid review LLM message');
    const parts = message.content.map((part: unknown) => {
      if (!isRecord(part) || part.type !== 'text' || (part.content != null && typeof part.content !== 'string')) {
        throw new Error('Review LLM messages support text content only');
      }
      return typeof part.content === 'string' ? part.content : '';
    });
    const text = parts.filter((part) => part.length > 0).join('\n\n');
    return new HumanMessage(text);
  });
  if (isRecord(schema)) {
    // Some compatible providers return free-form JSON even when the request includes response_format.
    const contract = `Return one JSON object matching this JSON Schema. Include all required fields and use the exact property names and enum values.\n${JSON.stringify(
      unwrapSchema(schema),
    )}`;
    const first = messages[0];
    if (first instanceof SystemMessage) messages[0] = new SystemMessage(`${first.content}\n\n${contract}`);
    else messages.unshift(new SystemMessage(contract));
  }
  return messages;
}

function reviewRequestId(processor: Processor): ID {
  const context: unknown = processor.execution.context;
  if (!isRecord(context) || !isRecord(context.data)) throw new Error('Review request context is missing');
  const { id, workflowId } = context.data;
  if (
    (typeof id !== 'number' && typeof id !== 'string') ||
    String(workflowId) !== String(processor.execution.workflowId)
  ) {
    throw new Error('Review request is not bound to this workflow revision');
  }
  return id;
}

/** A review-only LLM node that persists its pending job before any provider call begins. */
export class GitReviewLLMInstruction extends Instruction {
  async run(node: FlowNodeModel, input: JobModel | { result: unknown } | undefined, processor: Processor) {
    const requestId = reviewTestContext(processor.execution) ? null : reviewRequestId(processor);
    if (requestId !== null && !(await this.claimNode(requestId, processor.execution.id, node.id))) {
      await processor.exit();
      return;
    }
    const config: unknown = processor.getParsedValue(node.config, node.id);
    if (!isRecord(config) || typeof config.llmService !== 'string' || !isRecord(config.structuredOutput)) {
      throw new Error('Review LLM service and structured output are required');
    }
    const { llmService, messages, structuredOutput, ...modelOptions } = config;
    const parsedMessages = parseTextMessages(messages, structuredOutput.schema);
    const service = await this.workflow.db.getRepository('llmServices').findOne({ filter: { name: llmService } });
    const ai = this.workflow.app.pm.get('ai') as unknown as AIPlugin | undefined;
    const providerMeta = service && ai?.aiManager?.llmProviders.get(service.provider);
    if (!service || service.enabled === false || !providerMeta) throw new Error('Review LLM service is unavailable');
    const options: LLMProviderOptions = {
      app: this.workflow.app,
      serviceOptions: service.options,
      modelOptions: { ...modelOptions, structuredOutput },
      requestContext: { sessionId: `workflow-${processor.execution.id}-${node.id}` },
    };
    let provider: LLMProvider;
    try {
      provider = new providerMeta.provider(options);
      configureProviderStructuredOutput(provider, String(service.provider || ''));
    } catch (error) {
      const detail = formatProviderError(error);
      processor.logger.error('Git review LLM service initialization failed', { node: node.id, error: detail });
      throw new Error(detail ? `Review LLM service is unavailable: ${detail}` : 'Review LLM service is unavailable');
    }
    const job = processor.saveJob({
      status: JOB_STATUS.PENDING,
      nodeId: node.id,
      nodeKey: node.key,
      upstreamId: input && 'id' in input ? input.id : null,
    });
    const abort = processor.createBackgroundAbortHandle();
    try {
      await processor.exit();
    } catch (error) {
      abort.dispose();
      throw error;
    }

    const invoke = async (): Promise<ProviderOutcome> => {
      try {
        const response = await provider.invoke(
          {
            messages: parsedMessages as unknown as Parameters<LLMProvider['invoke']>[0]['messages'],
            structuredOutput: structuredOutput as Parameters<LLMProvider['invoke']>[0]['structuredOutput'],
          },
          { signal: abort.signal },
        );
        return { ok: true, response };
      } catch (error) {
        return { ok: false, error };
      }
    };
    const finish = async () => {
      try {
        const lock = await this.workflow.app.lockManager.tryAcquire(
          getExecutionLockKey(processor.execution.id),
          60_000,
        );
        const started = await lock.runExclusive(async () => {
          abort.throwIfAborted();
          if (requestId === null) return (await processor.findPendingJob(job.id)) ? { outcome: invoke() } : null;
          return this.withOwnedRequest(requestId, processor.execution.id, async (request, transaction) => {
            abort.throwIfAborted();
            const claims = request.get('llmClaims');
            if (!isRecord(claims) || claims[String(node.id)] !== String(processor.execution.id)) return null;
            const pending = await this.workflow.db.getCollection('jobs').model.findOne({
              where: { id: job.id, executionId: processor.execution.id, nodeId: node.id, status: JOB_STATUS.PENDING },
              transaction,
              lock: transaction.LOCK.UPDATE,
            });
            if (!pending) return null;
            abort.throwIfAborted();
            return { outcome: invoke() };
          });
        }, 60_000);
        if (!started) return;
        let status: typeof JOB_STATUS.RESOLVED | typeof JOB_STATUS.ERROR;
        let result: unknown;
        const outcome = await started.outcome;
        if (outcome.ok) {
          status = JOB_STATUS.RESOLVED;
          result = extractStructuredResult(outcome.response);
        } else {
          const error = outcome.error;
          if (abort.signal.aborted || isWorkflowTimeoutError(error)) return;
          const errorName = error instanceof Error ? error.name : 'Error';
          const detail = formatProviderError(error, provider);
          processor.logger.error('Git review LLM invocation failed', { node: node.id, errorName, error: detail });
          status = JOB_STATUS.ERROR;
          result = detail ? `Review LLM invocation failed: ${detail}` : 'Review LLM invocation failed';
        }
        abort.throwIfAborted();
        await this.settle(requestId, processor.execution.id, node.id, job.id, status, result, abort);
      } finally {
        abort.dispose();
      }
    };
    finish().catch((error: unknown) => {
      processor.logger.error('Git review LLM completion could not be recorded', {
        node: node.id,
        errorName: error instanceof Error ? error.name : 'Error',
        error: formatProviderError(error, provider),
      });
    });
  }

  private async withOwnedRequest<T>(
    requestId: ID,
    executionId: ID,
    work: (request: LockedRequest, transaction: Transaction) => Promise<T>,
  ): Promise<T | null> {
    return withOwnedRequest(this.workflow, requestId, executionId, work);
  }

  private async claimNode(requestId: ID, executionId: ID, nodeId: ID): Promise<boolean> {
    if (!/^\d+$/.test(String(nodeId))) throw new Error('Invalid review node');
    const claimed = await this.withOwnedRequest(requestId, executionId, async (request, transaction) => {
      const existing = request.get('llmClaims');
      if (existing != null && !isRecord(existing)) throw new Error('Invalid review LLM claims');
      const claims = existing ?? {};
      if (Object.prototype.hasOwnProperty.call(claims, String(nodeId))) return false;
      const jobs = await this.workflow.db.getCollection('jobs').model.count({
        where: { executionId, nodeId },
        transaction,
      });
      if (jobs) return false;
      await request.update({ llmClaims: { ...claims, [String(nodeId)]: String(executionId) } }, { transaction });
      return true;
    });
    return claimed === true;
  }

  private async isCurrentPendingRequest(requestId: ID, executionId: ID, nodeId: ID, jobId: ID): Promise<boolean> {
    const db = this.workflow.db;
    const request = await db.getRepository('gitReviewRequests').findOne({ filterByTk: requestId });
    if (!request || request.fenced || String(request.executionId) !== String(executionId)) return false;
    const execution = await db.getRepository('executions').findOne({ filterByTk: executionId });
    if (
      !execution ||
      execution.status !== EXECUTION_STATUS.STARTED ||
      String(execution.workflowId) !== String(request.workflowId)
    )
      return false;
    if (execution.expiresAt && new Date(execution.expiresAt).getTime() <= Date.now()) return false;
    const inbox = await db.getRepository('gitReviewInbox').findOne({ filterByTk: request.inboxId });
    if (!inbox || inbox.state !== 'running') return false;
    const project = await db.getRepository('gitReviewProjects').findOne({ filter: { projectKey: inbox.projectKey } });
    if (!project || String(project.activeInboxId) !== String(inbox.id)) return false;
    const job = await db.getRepository('jobs').findOne({ filterByTk: jobId });
    return Boolean(
      job &&
        job.status === JOB_STATUS.PENDING &&
        String(job.executionId) === String(executionId) &&
        String(job.nodeId) === String(nodeId),
    );
  }

  private async settle(
    requestId: ID | null,
    executionId: ID,
    nodeId: ID,
    jobId: ID,
    status: typeof JOB_STATUS.RESOLVED | typeof JOB_STATUS.ERROR,
    result: unknown,
    abort: BackgroundHandle,
  ) {
    const lock = await this.workflow.app.lockManager.tryAcquire(getExecutionLockKey(executionId), 60_000);
    await lock.runExclusive(async () => {
      abort.throwIfAborted();
      if (requestId !== null && !(await this.isCurrentPendingRequest(requestId, executionId, nodeId, jobId))) return;
      if (requestId === null) {
        const execution = await this.workflow.db.getRepository('executions').findOne({ filterByTk: executionId });
        if (!execution || execution.status !== EXECUTION_STATUS.STARTED || !reviewTestContext(execution)) return;
      }
      abort.throwIfAborted();
      const [updated] = await this.workflow.db
        .getModel('jobs')
        .update({ status, result }, { where: { id: jobId, executionId, nodeId, status: JOB_STATUS.PENDING } });
      if (updated !== 1) return;
      const job = await this.workflow.db.getRepository('jobs').findOne({ filterByTk: jobId });
      if (job) await this.workflow.resume(job);
    }, 60_000);
  }

  private async isContinuationFrontier(requestId: ID, executionId: ID, nodeId: ID, jobId: ID): Promise<boolean> {
    const allowed = await this.withOwnedRequest(requestId, executionId, async (request, transaction) => {
      const claims = request.get('llmClaims');
      if (!isRecord(claims) || claims[String(nodeId)] !== String(executionId)) return false;
      const node = await this.workflow.db.getCollection('flow_nodes').model.findOne({
        where: { id: nodeId, workflowId: request.get('workflowId'), type: 'git-review-llm' },
        transaction,
      });
      const job = await this.workflow.db.getCollection('jobs').model.findOne({
        where: { id: jobId, executionId, nodeId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!node || !job || ![JOB_STATUS.RESOLVED, JOB_STATUS.ERROR].some((status) => status === job.get('status')))
        return false;
      const downstreamId = node.get('downstreamId');
      if (downstreamId == null) return false;
      const nextNode = await this.workflow.db.getCollection('flow_nodes').model.findOne({
        where: { id: downstreamId, workflowId: request.get('workflowId') },
        transaction,
      });
      if (!nextNode) return false;
      const nextJob = await this.workflow.db.getCollection('jobs').model.findOne({
        where: { executionId, nodeId: downstreamId },
        transaction,
      });
      if (nextJob) {
        if (nextNode.get('type') !== 'git-review-result') return false;
        const followingId = nextNode.get('downstreamId');
        const following =
          followingId == null
            ? null
            : await this.workflow.db.getCollection('flow_nodes').model.findOne({
                where: { id: followingId, workflowId: request.get('workflowId'), type: 'manual' },
                transaction,
              });
        if (!following) return false;
        const manualJob = await this.workflow.db.getCollection('jobs').model.findOne({
          where: { executionId, nodeId: followingId },
          transaction,
        });
        return !manualJob;
      }
      if (
        nextNode.get('type') === 'git-review-llm' &&
        Object.prototype.hasOwnProperty.call(claims, String(downstreamId))
      )
        return false;
      return true;
    });
    return allowed === true;
  }

  /** A terminal LLM job is itself the durable continuation record. */
  async reconcileContinuations(requestId: ID, executionId: ID): Promise<void> {
    const jobs = await this.workflow.db.getRepository('jobs').find({
      filter: { executionId, status: [JOB_STATUS.RESOLVED, JOB_STATUS.ERROR] },
      fields: ['id', 'nodeId', 'executionId', 'status'],
    });
    for (const job of jobs) {
      const lock = await this.workflow.app.lockManager.tryAcquire(getExecutionLockKey(executionId), 60_000);
      await lock.runExclusive(async () => {
        if (!(await this.isContinuationFrontier(requestId, executionId, job.nodeId, job.id))) return;
        const terminal = await this.workflow.db.getRepository('jobs').findOne({ filterByTk: job.id });
        if (terminal) await this.workflow.resume(terminal);
      }, 60_000);
    }
  }

  async resume(node: FlowNodeModel, job: IJob, processor: Processor): Promise<IJob | void> {
    if (reviewTestContext(processor.execution)) return job;
    const id = job.id;
    if (
      (typeof id !== 'number' && typeof id !== 'string') ||
      !(await this.isContinuationFrontier(reviewRequestId(processor), processor.execution.id, node.id, id))
    ) {
      await processor.exit();
      return;
    }
    return job;
  }
}
