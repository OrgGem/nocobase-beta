/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { ExecutionSpanService } from './ExecutionSpanService';
import { makeNativeRunId, NATIVE_SOURCE } from './NativeSubAgentObserver';
import { TokenTracker, usageFromAIUsageEvent } from './TokenTracker';
import { resolveTracingRetentionDays } from './TracingRetentionPolicy';
import { asObject, toPlain } from '../utils/ctx-utils';

type NativeRecord = Record<string, unknown> & { get?: (key: string) => unknown };

type NativeRepository = {
  create: (options: Record<string, unknown>) => Promise<unknown>;
  update: (options: Record<string, unknown>) => Promise<unknown>;
  find?: (options?: Record<string, unknown>) => Promise<unknown[]>;
  findOne?: (options?: Record<string, unknown>) => Promise<unknown>;
};

type NativePlugin = {
  app: {
    logger?: {
      warn?: (
        message: string,
        meta?: { module?: string; submodule?: string; method?: string; [key: string]: unknown },
      ) => void;
    };
  };
  db: { getRepository: (name: string) => NativeRepository | undefined };
};

type PageCursor = { after?: string; done?: boolean };
type NativeCursor = {
  version: 2;
  conversations: PageCursor;
  messages: PageCursor;
  toolMessages: PageCursor;
  usageEvents: PageCursor;
};

type SyncPage = { rows: NativeRecord[]; hasMore: boolean };

type SyncCounts = {
  conversations: number;
  messages: number;
  linkedSubAgents: number;
  toolMessages: number;
  modelCalls: number;
  skipped: number;
  correlationIncomplete: number;
};

const MAX_PAGE_SIZE = 1000;
const MAX_RELATIONS_PER_MESSAGE = 100;
const DISABLED_NATIVE_CAPTURE = {
  source: 'native-persistence-no-invocation-snapshot',
  sharing: 'disabled',
  captureInputs: false,
  captureOutputs: false,
  redactSecrets: true,
};

function recordOf(value: unknown): NativeRecord {
  const plain = toPlain(value);
  return plain && typeof plain === 'object' && !Array.isArray(plain) ? (plain as NativeRecord) : {};
}

function stringValue(value: unknown) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return '';
}

function nativeRootIdentity(sessionId: string) {
  return 'native:conversation:' + sessionId;
}

function nativeToolIdentity(toolCallId: string) {
  return 'native:tool-call:' + toolCallId;
}

function sessionRootRunId(sessionId: string) {
  return makeNativeRunId(['main', sessionId]);
}

function parseDate(value: unknown) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : undefined;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(typeof value === 'string' && /^\d{12,}$/.test(value) ? Number(value) : value);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }
  return undefined;
}

function latestDate(...values: unknown[]) {
  const dates = values.map(parseDate).filter((date): date is Date => Boolean(date));
  return dates.reduce<Date | undefined>((latest, date) => (!latest || date > latest ? date : latest), undefined);
}

function numberValue(value: unknown) {
  if (value === null || value === undefined || value === '') return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function isSubAgentConversation(conversation: NativeRecord) {
  return stringValue(conversation.from) === 'sub-agent';
}

function statusForConversation(conversation: NativeRecord) {
  const state = stringValue(conversation.llmActiveState).toLowerCase();
  if (state === 'streaming' || state === 'invoking') return 'running';
  // plugin-ai persists conversation sessions, not per-request completion records. An idle
  // session cannot prove that its most recent invocation completed successfully or failed.
  return 'unknown';
}

function statusForTool(toolMessage: NativeRecord) {
  const invokeStatus = stringValue(toolMessage.invokeStatus).toLowerCase();
  const resultStatus = stringValue(toolMessage.status).toLowerCase();
  if (resultStatus === 'error' || invokeStatus === 'error' || invokeStatus === 'failed') return 'error';
  if (invokeStatus === 'interrupted' || invokeStatus === 'waiting') return 'waiting_approval';
  if (invokeStatus === 'done' || invokeStatus === 'confirmed') return resultStatus === 'error' ? 'error' : 'success';
  if (invokeStatus === 'init' || invokeStatus === 'pending') return 'running';
  return 'unknown';
}

function metadataForNativeProjection(extra: Record<string, unknown> = {}) {
  return {
    source: NATIVE_SOURCE,
    nativeCoverage: {
      source: 'persisted-native-records',
      realtime: false,
      contentCapture: 'unsupported-without-invocation-snapshot',
    },
    capturePolicy: DISABLED_NATIVE_CAPTURE,
    ...extra,
  };
}

export function parseNativeMonitorCursor(value: unknown): NativeCursor {
  if (value == null) return { version: 2, conversations: {}, messages: {}, toolMessages: {}, usageEvents: {} };
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native monitor cursor.');
  const cursor = value as Partial<NativeCursor>;
  if (cursor.version !== 2) throw new Error('Unsupported native monitor cursor version.');
  const parsePage = (entry: unknown): PageCursor => {
    const page = asObject(entry);
    if (page.after !== undefined && (typeof page.after !== 'string' || !page.after)) {
      throw new Error('Invalid native monitor cursor position.');
    }
    if (page.done !== undefined && typeof page.done !== 'boolean')
      throw new Error('Invalid native monitor cursor state.');
    return { ...(page.after ? { after: page.after as string } : {}), ...(page.done ? { done: true } : {}) };
  };
  return {
    version: 2,
    conversations: parsePage(cursor.conversations),
    messages: parsePage(cursor.messages),
    toolMessages: parsePage(cursor.toolMessages),
    usageEvents: parsePage(cursor.usageEvents),
  };
}

export class NativeAgentMonitorSyncService {
  private readonly spans: ExecutionSpanService;
  private readonly usageTracker: TokenTracker;

  constructor(private readonly plugin: NativePlugin) {
    this.spans = new ExecutionSpanService(plugin);
    this.usageTracker = new TokenTracker(plugin);
  }

  async sync(options: { limit?: number; cursor?: unknown; sessionId?: string } = {}) {
    const limit = Math.min(Math.max(Math.trunc(Number(options.limit) || 200), 1), MAX_PAGE_SIZE);
    const retentionDays = await resolveTracingRetentionDays(this.plugin);
    const cutoff = new Date(Date.now() - retentionDays * 86400000);
    const cursor = parseNativeMonitorCursor(options.cursor);
    const counts: SyncCounts = {
      conversations: 0,
      messages: 0,
      linkedSubAgents: 0,
      toolMessages: 0,
      modelCalls: 0,
      skipped: 0,
      correlationIncomplete: 0,
    };
    const pages: Record<string, { processed: number; hasMore: boolean }> = {};
    const sessionFilter = options.sessionId ? { sessionId: options.sessionId } : {};
    const page = async (
      name: keyof Omit<NativeCursor, 'version'>,
      repositoryName: string,
      key: string,
      filter: Record<string, unknown>,
      project: (record: NativeRecord) => Promise<void>,
    ) => {
      const position = cursor[name];
      if (position.done) {
        pages[name] = { processed: 0, hasMore: false };
        return;
      }
      const rows = await this.fetchPage(repositoryName, {
        filter: position.after ? { $and: [filter, { [key]: { $gt: position.after } }] } : filter,
        sort: [key],
        limit,
      });
      for (const row of rows.rows) await project(row);
      const last = rows.rows[rows.rows.length - 1];
      const after = last ? stringValue(last[key]) : position.after;
      if (last && !after) throw new Error(`Native monitor source ${repositoryName} has no ${key}.`);
      cursor[name] = { ...(after ? { after } : {}), ...(!rows.hasMore ? { done: true } : {}) };
      pages[name] = { processed: rows.rows.length, hasMore: rows.hasMore };
    };

    await page(
      'conversations',
      'aiConversations',
      'sessionId',
      { ...sessionFilter, from: { $ne: 'sub-agent' } },
      async (conversation) => {
        const sessionId = stringValue(conversation.sessionId);
        if (!sessionId) {
          counts.skipped += 1;
          return;
        }
        if (await this.upsertMainConversation(conversation, cutoff, counts)) counts.conversations += 1;
      },
    );

    await page('messages', 'aiMessages', 'messageId', sessionFilter, async (message) => {
      counts.messages += 1;
      counts.linkedSubAgents += await this.projectSubAgentRelations(message, counts, cutoff);
    });

    await page('toolMessages', 'aiToolMessages', 'id', sessionFilter, async (toolMessage) => {
      if (await this.projectToolMessage(toolMessage, counts, cutoff)) counts.toolMessages += 1;
    });

    await page('usageEvents', 'aiUsageEvents', 'id', { ...sessionFilter, eventType: 'llm_message' }, async (event) => {
      if (await this.projectUsageEvent(event, counts, cutoff)) counts.modelCalls += 1;
    });

    const complete =
      cursor.conversations.done && cursor.messages.done && cursor.toolMessages.done && cursor.usageEvents.done;

    return {
      data: {
        coverage: {
          source: 'persisted-native-records',
          realtime: false,
          granularity: 'conversation-session-and-persisted-calls',
          note: 'Main-agent records are session-level. This is a bounded full-pass reconciliation, not a realtime or per-request trace; repeat complete passes to capture source updates and late records.',
          contentCapture: 'omitted-without-invocation-policy-snapshot',
          maxRelationsPerMessage: MAX_RELATIONS_PER_MESSAGE,
          traceRetentionDays: retentionDays,
        },
        counts,
        pages,
        complete: Boolean(complete),
        cursor: complete ? null : cursor,
      },
    };
  }

  async syncSession(sessionId: string) {
    if (!sessionId) throw new Error('A native session id is required.');
    // A single bounded page avoids unbounded work in the API lifecycle. Durable usage
    // events and any remaining pages are recovered by a subsequent explicit full pass.
    return this.sync({ sessionId, limit: 200 });
  }

  private async fetchPage(name: string, options: Record<string, unknown>): Promise<SyncPage> {
    try {
      const repository = this.plugin.db.getRepository(name);
      if (!repository?.find) throw new Error(`Native monitor source ${name} is unavailable.`);
      const rows = await repository.find(options);
      const limit = Number(options.limit) || 0;
      const values = Array.isArray(rows) ? rows.map(recordOf) : [];
      return { rows: values, hasMore: values.length === limit };
    } catch (error) {
      this.warn('[AgentOrchestrator] Failed to sync native ' + name, error);
      throw error;
    }
  }

  private async resolveRunAssociation(rawRunId: unknown) {
    const runId = numberValue(rawRunId);
    if (!Number.isSafeInteger(runId) || !runId || runId < 0) {
      return {
        runId: rawRunId == null || rawRunId === '' ? undefined : null,
        missing: rawRunId != null && rawRunId !== '',
      };
    }
    const run = await this.findOne('agentLoopRuns', { filterByTk: runId });
    return run
      ? { runId, rootRunId: stringValue(run.rootRunId) || undefined, missing: false }
      : { runId: null, missing: true };
  }

  private withinRetention(activity: Date | undefined, cutoff: Date, counts: SyncCounts) {
    if (!activity) {
      counts.skipped += 1;
      counts.correlationIncomplete += 1;
      return false;
    }
    if (activity < cutoff) {
      counts.skipped += 1;
      return false;
    }
    return true;
  }

  private async upsertMainConversation(
    conversation: NativeRecord,
    cutoff: Date,
    counts: SyncCounts,
    minimumActivity?: Date,
  ) {
    const sessionId = stringValue(conversation.sessionId);
    const employeeUsername = stringValue(conversation.aiEmployeeUsername) || undefined;
    const createdAt = parseDate(conversation.createdAt);
    const updatedAt = parseDate(conversation.updatedAt);
    const latestUsage = await this.findOne('aiUsageEvents', {
      filter: { sessionId, eventType: 'llm_message' },
      sort: ['-occurredAt'],
    });
    const activity = latestDate(createdAt, updatedAt, latestUsage?.occurredAt, minimumActivity);
    if (!this.withinRetention(activity, cutoff, counts)) return null;
    const association = await this.resolveRunAssociation(asObject(conversation.options).controlPlaneRunId);
    if (association.missing && counts) counts.correlationIncomplete += 1;
    const previous = await this.findOne('agentExecutionSpans', {
      filter: { nativeIdentity: nativeRootIdentity(sessionId) },
    });
    const saved = await this.spans.upsertNative(nativeRootIdentity(sessionId), {
      nativeIdentity: nativeRootIdentity(sessionId),
      rootRunId: association.rootRunId || stringValue(previous?.rootRunId) || sessionRootRunId(sessionId),
      agentLoopRunId: association.runId,
      source: NATIVE_SOURCE,
      parentSessionId: sessionId,
      subSessionId: sessionId,
      type: 'main_agent',
      status: statusForConversation(conversation),
      leaderUsername: employeeUsername,
      employeeUsername,
      toolName: 'native-agent-session',
      title: 'Native agent session',
      startedAt: createdAt || activity,
      nativeActivityAt: activity,
      // Idle is not proof that a session-level root completed. Keep it open-ended.
      ...(stringValue(conversation.llmActiveState) === 'completed' && updatedAt ? { endedAt: updatedAt } : {}),
      metadata: metadataForNativeProjection({
        nativeSessionId: sessionId,
        nativeStatus: stringValue(conversation.llmActiveState) || 'idle',
        category: stringValue(conversation.category) || 'chat',
        from: stringValue(conversation.from) || 'main-agent',
        scope: stringValue(conversation.scope) || undefined,
        sessionGranularity: true,
        correlationIncomplete: Boolean(conversation.orphanedUsage) || association.missing,
      }),
      userId: stringValue(conversation.userId) || undefined,
    });
    if (!saved) throw new Error('Could not persist native session projection.');
    return saved;
  }

  private async projectSubAgentRelations(message: NativeRecord, counts: SyncCounts, cutoff: Date) {
    const parentSessionId = stringValue(message.sessionId);
    const relations = asObject(message.metadata).subAgentConversations;
    if (!parentSessionId || !Array.isArray(relations)) return 0;
    const parentConversation = await this.findOne('aiConversations', { filter: { sessionId: parentSessionId } });
    if (!parentConversation) {
      counts.correlationIncomplete += relations.length;
      return 0;
    }
    let projected = 0;
    if (relations.length > MAX_RELATIONS_PER_MESSAGE) {
      counts.correlationIncomplete += relations.length - MAX_RELATIONS_PER_MESSAGE;
    }
    for (const relationValue of relations.slice(0, MAX_RELATIONS_PER_MESSAGE)) {
      const relation = asObject(relationValue);
      const childSessionId = stringValue(relation.sessionId);
      const toolCallId = stringValue(relation.toolCallId);
      if (!childSessionId || !toolCallId) {
        counts.skipped += 1;
        continue;
      }
      const childConversation = await this.findOne('aiConversations', { filter: { sessionId: childSessionId } });
      const toolMessage = await this.findOne('aiToolMessages', { filter: { toolCallId } });
      const activity = latestDate(
        toolMessage?.invokeEndTime,
        toolMessage?.invokeStartTime,
        toolMessage?.updatedAt,
        toolMessage?.createdAt,
        message.updatedAt,
        message.createdAt,
      );
      if (!this.withinRetention(activity, cutoff, counts)) continue;
      const parent = await this.resolveParentSpan(parentConversation, cutoff, counts, activity);
      if (!parent) {
        counts.correlationIncomplete += 1;
        continue;
      }
      const saved = await this.spans.upsertNative(
        nativeToolIdentity(toolCallId),
        this.subAgentSpanValues({
          parent,
          parentConversation,
          childConversation,
          childSessionId,
          toolCallId,
          messageId: stringValue(message.messageId),
          nativeStatus: stringValue(relation.status),
          toolStatus: toolMessage ? statusForTool(toolMessage) : undefined,
          nativeActivityAt: activity,
        }),
      );
      if (!saved) throw new Error('Could not persist native sub-agent projection.');
      projected += 1;
    }
    return projected;
  }

  private async projectToolMessage(toolMessage: NativeRecord, counts: SyncCounts, cutoff: Date) {
    const toolCallId = stringValue(toolMessage.toolCallId);
    const sessionId = stringValue(toolMessage.sessionId);
    if (!toolCallId || !sessionId) {
      counts.skipped += 1;
      return false;
    }
    const activity = latestDate(
      toolMessage.invokeEndTime,
      toolMessage.invokeStartTime,
      toolMessage.updatedAt,
      toolMessage.createdAt,
    );
    if (!this.withinRetention(activity, cutoff, counts)) return false;
    const parentConversation = await this.findOne('aiConversations', { filter: { sessionId } });
    if (!parentConversation) {
      counts.correlationIncomplete += 1;
      return false;
    }
    const parent = await this.resolveParentSpan(parentConversation, cutoff, counts, activity);
    if (!parent) {
      counts.correlationIncomplete += 1;
      return false;
    }

    const message = await this.findOne('aiMessages', {
      filter: { sessionId, messageId: stringValue(toolMessage.messageId) },
    });
    const child = this.findSubAgentRelation(message, toolCallId);
    const childSessionId = stringValue(child?.sessionId || asObject(toolMessage.content).sessionId);
    const childConversation = childSessionId
      ? await this.findOne('aiConversations', { filter: { sessionId: childSessionId } })
      : null;
    const toolName = stringValue(toolMessage.toolName);
    const isDispatch = toolName === 'dispatch-sub-agent-task';
    const isSubAgent = isDispatch && Boolean(childSessionId);
    const invokeStart = parseDate(toolMessage.invokeStartTime);
    const invokeEnd = parseDate(toolMessage.invokeEndTime);
    const durationMs =
      invokeStart && invokeEnd && invokeEnd >= invokeStart ? invokeEnd.getTime() - invokeStart.getTime() : undefined;
    const identity = nativeToolIdentity(toolCallId);
    const values = isSubAgent
      ? this.subAgentSpanValues({
          parent,
          parentConversation,
          childConversation,
          childSessionId,
          toolCallId,
          messageId: stringValue(toolMessage.messageId),
          nativeStatus: stringValue(child?.status || toolMessage.invokeStatus),
          toolStatus: statusForTool(toolMessage),
          startedAt: invokeStart || parseDate(toolMessage.createdAt) || activity,
          endedAt: invokeEnd,
          durationMs,
          nativeActivityAt: activity,
        })
      : {
          rootRunId: stringValue(parent.rootRunId) || sessionRootRunId(sessionId),
          agentLoopRunId: parent.agentLoopRunId == null ? null : String(parent.agentLoopRunId),
          parentSpanId: parent.id === undefined ? undefined : String(parent.id),
          source: NATIVE_SOURCE,
          parentSessionId: sessionId,
          toolCallId,
          type: isDispatch ? 'dispatch' : 'tool',
          status: statusForTool(toolMessage),
          leaderUsername: stringValue(parentConversation.aiEmployeeUsername) || undefined,
          employeeUsername: stringValue(parentConversation.aiEmployeeUsername) || undefined,
          toolName,
          title: toolName || 'Native tool call',
          startedAt: invokeStart || parseDate(toolMessage.createdAt) || activity,
          nativeActivityAt: activity,
          endedAt: invokeEnd,
          durationMs,
          metadata: metadataForNativeProjection({
            nativeIdentity: identity,
            nativeStatus: stringValue(toolMessage.status),
            invokeStatus: stringValue(toolMessage.invokeStatus),
            messageId: stringValue(toolMessage.messageId),
            toolMessageId: stringValue(toolMessage.id),
          }),
          userId: stringValue(parentConversation.userId) || undefined,
        };
    if (!(await this.spans.upsertNative(identity, values)))
      throw new Error('Could not persist native tool projection.');
    return true;
  }

  private async projectUsageEvent(event: NativeRecord, counts: SyncCounts, cutoff: Date) {
    const sessionId = stringValue(event.sessionId);
    const messageId = stringValue(event.messageId);
    if (!sessionId || !messageId) {
      counts.skipped += 1;
      return false;
    }
    const conversation = await this.findOne('aiConversations', { filter: { sessionId } });
    const eventActivity = parseDate(event.occurredAt);
    let parent = conversation ? await this.resolveParentSpan(conversation, cutoff, counts, eventActivity) : null;
    if (!conversation && stringValue(event.from) !== 'sub-agent') {
      // API gateway conversations are temporary, while usage events retain user and employee identity.
      // Recreate only a session-level projection, without inventing request or message content.
      const synthetic = {
        sessionId,
        userId: event.userId,
        aiEmployeeUsername: event.aiEmployeeUsername,
        from: event.from || 'main-agent',
        category: event.category,
        createdAt: event.occurredAt,
        orphanedUsage: true,
      };
      const root = await this.upsertMainConversation(synthetic, cutoff, counts);
      parent = root ? recordOf(root) : null;
    }
    if (!parent) counts.correlationIncomplete += 1;

    const usageIdentity = 'ai-usage-event:' + sessionId + ':' + messageId;
    const rawRunId = asObject(conversation?.options).controlPlaneRunId ?? parent?.agentLoopRunId;
    const association = await this.resolveRunAssociation(rawRunId);
    if (association.missing) counts.correlationIncomplete += 1;
    const saved = await this.usageTracker.recordModelCallUsage({
      usageIdentity,
      nativeIdentity: usageIdentity,
      sessionId,
      messageId,
      usage: usageFromAIUsageEvent(event),
      model: stringValue(event.model) || undefined,
      provider: stringValue(event.provider) || undefined,
      llmService: stringValue(event.llmService) || undefined,
      runId: association.runId,
      rootRunId: association.rootRunId || stringValue(parent?.rootRunId) || sessionRootRunId(sessionId),
      parentSpanId: parent?.id === undefined ? undefined : String(parent.id),
      role: stringValue(event.role) || undefined,
      employeeUsername: stringValue(event.aiEmployeeUsername || conversation?.aiEmployeeUsername) || undefined,
      userId: stringValue(event.userId || conversation?.userId) || undefined,
      source: 'ai_usage_event',
      occurredAt: parseDate(event.occurredAt),
    });
    if (saved === undefined) throw new Error('Could not persist native model usage projection.');
    return true;
  }

  private subAgentSpanValues(options: {
    parent: NativeRecord;
    parentConversation: NativeRecord;
    childConversation: NativeRecord | null;
    childSessionId: string;
    toolCallId: string;
    messageId?: string;
    nativeStatus?: string;
    toolStatus?: string;
    startedAt?: Date;
    endedAt?: Date;
    durationMs?: number;
    nativeActivityAt?: Date;
  }) {
    const { parent, parentConversation, childConversation, childSessionId, toolCallId } = options;
    const startedAt = options.startedAt || parseDate(childConversation?.createdAt) || options.nativeActivityAt;
    return {
      rootRunId: stringValue(parent.rootRunId) || sessionRootRunId(stringValue(parentConversation.sessionId)),
      agentLoopRunId: parent.agentLoopRunId == null ? null : String(parent.agentLoopRunId),
      parentSpanId: parent.id === undefined ? undefined : String(parent.id),
      source: NATIVE_SOURCE,
      parentSessionId: stringValue(parentConversation.sessionId),
      subSessionId: childSessionId,
      toolCallId,
      type: 'sub_agent',
      status:
        options.toolStatus && options.toolStatus !== 'unknown'
          ? options.toolStatus
          : this.statusForNativeRelation(options.nativeStatus) !== 'unknown'
            ? this.statusForNativeRelation(options.nativeStatus)
            : childConversation
              ? statusForConversation(childConversation)
              : 'unknown',
      depth: (numberValue(parent.depth) || 0) + 1,
      leaderUsername: stringValue(parentConversation.aiEmployeeUsername) || undefined,
      employeeUsername: stringValue(childConversation?.aiEmployeeUsername) || undefined,
      toolName: 'dispatch-sub-agent-task',
      title: 'Native sub-agent dispatch',
      startedAt,
      nativeActivityAt: options.nativeActivityAt,
      endedAt: options.endedAt,
      durationMs: options.durationMs,
      metadata: metadataForNativeProjection({
        nativeIdentity: nativeToolIdentity(toolCallId),
        nativeStatus: options.nativeStatus || undefined,
        messageId: options.messageId || undefined,
        childSessionId,
      }),
      userId: stringValue(childConversation?.userId || parentConversation.userId) || undefined,
    };
  }

  private statusForNativeRelation(status: string | undefined) {
    if (status === 'success' || status === 'completed' || status === 'done') return 'success';
    if (status === 'error' || status === 'failed') return 'error';
    if (status === 'interrupted' || status === 'waiting') return 'waiting_approval';
    if (status === 'pending' || status === 'running') return 'running';
    return 'unknown';
  }

  private findSubAgentRelation(message: NativeRecord | null, toolCallId: string) {
    const relations = asObject(message?.metadata).subAgentConversations;
    if (!Array.isArray(relations)) return null;
    const matched = relations
      .slice(0, MAX_RELATIONS_PER_MESSAGE)
      .find((value) => stringValue(asObject(value).toolCallId) === toolCallId);
    return matched ? asObject(matched) : null;
  }

  private async resolveParentSpan(
    conversation: NativeRecord,
    cutoff: Date,
    counts: SyncCounts,
    activity?: Date,
  ): Promise<NativeRecord | null> {
    const sessionId = stringValue(conversation.sessionId);
    if (!sessionId) return null;
    if (isSubAgentConversation(conversation)) {
      const canonical = await this.findOne('agentExecutionSpans', {
        filter: { source: NATIVE_SOURCE, type: 'sub_agent', subSessionId: sessionId, nativeIdentity: { $ne: null } },
      });
      const parent =
        canonical ||
        (await this.findOne('agentExecutionSpans', {
          filter: { source: NATIVE_SOURCE, type: 'sub_agent', subSessionId: sessionId },
        }));
      if (!parent) return null;
      const parentActivity = latestDate(parent.nativeActivityAt, parent.startedAt, parent.createdAt, activity);
      if (!this.withinRetention(parentActivity, cutoff, counts)) return null;
      if (activity && activity >= cutoff) await this.advanceAncestorActivity(parent, activity, counts);
      return parent;
    }
    const root = await this.upsertMainConversation(conversation, cutoff, counts, activity);
    return root ? recordOf(root) : null;
  }

  private async advanceAncestorActivity(start: NativeRecord, activity: Date, counts: SyncCounts) {
    let node: NativeRecord | null = start;
    const visited = new Set<string>();
    while (node && node.id !== undefined && visited.size < 32) {
      const id = stringValue(node.id);
      if (!id || visited.has(id)) break;
      visited.add(id);
      await this.spans.advanceNativeActivity(id, activity);
      const parentId = stringValue(node.parentSpanId);
      node = parentId ? await this.findOne('agentExecutionSpans', { filterByTk: parentId }) : null;
    }
    if (node && visited.size >= 32) counts.correlationIncomplete += 1;
  }

  private async findOne(name: string, options: Record<string, unknown>): Promise<NativeRecord | null> {
    const repository = this.plugin.db.getRepository(name);
    if (!repository?.findOne) throw new Error(`Native monitor source ${name} is unavailable.`);
    const row = await repository.findOne(options);
    return row ? recordOf(row) : null;
  }

  private warn(message: string, error: unknown) {
    try {
      this.plugin.app.logger?.warn?.(message, { error });
    } catch {
      // Telemetry logging is best effort.
    }
  }
}
