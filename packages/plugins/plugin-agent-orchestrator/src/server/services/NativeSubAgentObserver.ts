/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'crypto';
import { ExecutionSpanService } from './ExecutionSpanService';
import { AgentMemoryContextService } from './AgentMemoryContextService';
import { asObject } from '../utils/ctx-utils';

export const NATIVE_SOURCE = 'native-plugin-ai';
const WRAP_STATE_KEY = Symbol.for('plugin-agent-orchestrator.nativeSubAgentObserver');

type NativeRepository = {
  create: (options: Record<string, unknown>) => Promise<unknown>;
  update: (options: Record<string, unknown>) => Promise<unknown>;
  find?: (options?: Record<string, unknown>) => Promise<unknown[]>;
  findOne?: (options: Record<string, unknown>) => Promise<unknown>;
};

type NativeContext = {
  action?: { params?: { values?: Record<string, unknown> } };
  auth?: { user?: { id?: string | number } };
  db?: { getRepository?: (name: string) => NativeRepository | undefined };
};

type NativeSubAgentTask = {
  ctx: NativeContext;
  sessionId: string;
  employee: unknown;
  model?: unknown;
  question: string;
  skillSettings?: Record<string, unknown>;
  writer?: (chunk: Record<string, unknown>) => unknown;
};

type DispatcherWithRun = {
  run: (task: NativeSubAgentTask) => Promise<string>;
  [WRAP_STATE_KEY]?: {
    originalRun: (task: NativeSubAgentTask) => Promise<string>;
    wrappedRun: (task: NativeSubAgentTask) => Promise<string>;
  };
};

type ObserverPlugin = {
  app: {
    logger?: {
      info?: (
        message: string,
        meta?: { module?: string; submodule?: string; method?: string; [key: string]: unknown },
      ) => void;
      warn?: (
        message: string,
        meta?: { module?: string; submodule?: string; method?: string; [key: string]: unknown },
      ) => void;
    };
    pm?: { get?: (name: string) => unknown };
  };
  db: { getRepository: (name: string) => NativeRepository | undefined };
};

type ObserverSettings = {
  nativeObserverEnabled?: boolean;
  harnessTag?: string;
  observability?: {
    enabled?: boolean;
    sharing?: string;
  };
};

function objectValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readValue(record: unknown, key: string) {
  const model = record as { get?: (name: string) => unknown; [name: string]: unknown };
  return typeof model?.get === 'function' ? model.get(key) : model?.[key];
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function makeNativeRunId(parts: Array<string | number | undefined>) {
  const source = parts.map((part) => String(part || '')).join('|');
  return (
    'native_' +
    createHash('sha1')
      .update(source || String(Date.now()))
      .digest('hex')
      .slice(0, 24)
  );
}

function errorText(error: unknown) {
  try {
    return error instanceof Error ? error.message : String(error || 'Unknown error');
  } catch {
    return 'Unknown error';
  }
}

function rowAsObject(value: unknown) {
  const record = value as { toJSON?: () => unknown };
  const resolved = typeof record?.toJSON === 'function' ? record.toJSON() : value;
  return objectValue(resolved);
}

export class NativeSubAgentObserver {
  private readonly spanService: ExecutionSpanService;
  private readonly policyService: AgentMemoryContextService;

  constructor(private readonly plugin: ObserverPlugin) {
    this.spanService = new ExecutionSpanService(plugin);
    this.policyService = new AgentMemoryContextService(plugin);
  }

  install() {
    const aiPlugin = this.plugin.app.pm?.get?.('ai');
    const dispatcher = objectValue(aiPlugin).subAgentsDispatcher as DispatcherWithRun | undefined;
    if (!dispatcher?.run) {
      this.warn('[AgentOrchestrator] plugin-ai subAgentsDispatcher not available; observer skipped.');
      return false;
    }

    const existing = dispatcher[WRAP_STATE_KEY];
    if (existing?.wrappedRun === dispatcher.run) return false;

    const originalRun = existing?.originalRun || dispatcher.run.bind(dispatcher);
    const observer = this;
    const wrappedRun = async function wrappedNativeSubAgentRun(task: NativeSubAgentTask) {
      return observer.runObserved(originalRun, task);
    };

    dispatcher.run = wrappedRun;
    dispatcher[WRAP_STATE_KEY] = { originalRun, wrappedRun };
    this.info('[AgentOrchestrator] Native plugin-ai sub-agent observer installed.');
    return true;
  }

  uninstall() {
    const aiPlugin = this.plugin.app.pm?.get?.('ai');
    const dispatcher = objectValue(aiPlugin).subAgentsDispatcher as DispatcherWithRun | undefined;
    const existing = dispatcher?.[WRAP_STATE_KEY];
    if (!dispatcher?.run || !existing || existing.wrappedRun !== dispatcher.run) return false;

    dispatcher.run = existing.originalRun;
    delete dispatcher[WRAP_STATE_KEY];
    this.info('[AgentOrchestrator] Native plugin-ai sub-agent observer uninstalled.');
    return true;
  }

  private async runObserved(originalRun: (task: NativeSubAgentTask) => Promise<string>, task: NativeSubAgentTask) {
    const startedAt = Date.now();
    try {
      // Preserve the native task object, writer, prompt, skill settings, and result exactly.
      const result = await originalRun(task);
      this.observeDispatch(task, 'success', startedAt).catch((error) => {
        this.warn('[AgentOrchestrator] Native dispatch telemetry failed; continuing native execution.', error);
      });
      return result;
    } catch (error) {
      this.observeDispatch(task, 'error', startedAt).catch((telemetryError) => {
        this.warn('[AgentOrchestrator] Native dispatch telemetry failed; continuing native execution.', telemetryError);
      });
      throw error;
    }
  }

  private async observeDispatch(task: NativeSubAgentTask, status: 'success' | 'error', startedAt: number) {
    try {
      const settings = (await this.policyService.resolvePolicySettings(task)) as ObserverSettings;
      if (settings.nativeObserverEnabled === false || settings.observability?.enabled === false) return;
      if (settings.observability?.sharing === 'disabled') return;

      const parentSessionId = stringValue(task.ctx?.action?.params?.values?.sessionId);
      const subSessionId = stringValue(task.sessionId);
      const employeeUsername =
        stringValue(readValue(task.employee, 'username')) ||
        stringValue(readValue(task.employee, 'aiEmployeeUsername')) ||
        stringValue(readValue(task.employee, 'name')) ||
        undefined;
      const dispatch = await this.resolveDispatch(parentSessionId, subSessionId, task.ctx.db);
      const toolCallId = dispatch?.toolCallId;
      if (!parentSessionId || !subSessionId || !toolCallId) return;

      const parentConversation = await this.findOne(task.ctx.db, 'aiConversations', {
        filter: { sessionId: parentSessionId },
      });
      const parentSpan = await this.findParentSpan(parentConversation, parentSessionId);
      // If the main projection is not yet available, let reconciliation link this call later;
      // inventing a root here can race a valid legacy control-plane association.
      if (!parentSpan) return;
      const rootRunId = stringValue(parentSpan.rootRunId);
      if (!rootRunId) return;
      const parentSpanId = parentSpan?.id === undefined ? undefined : String(parentSpan.id);
      const endedAt = new Date();
      const nativeIdentity = 'native:tool-call:' + toolCallId;
      const span = await this.spanService.upsertNative(nativeIdentity, {
        nativeIdentity,
        rootRunId,
        parentSpanId,
        depth: Number(parentSpan?.depth) + 1 || 1,
        source: NATIVE_SOURCE,
        parentSessionId,
        subSessionId,
        toolCallId,
        type: 'sub_agent',
        status: status === 'error' ? 'error' : 'unknown',
        leaderUsername: stringValue(readValue(parentConversation, 'aiEmployeeUsername')) || undefined,
        employeeUsername,
        toolName: 'dispatch-sub-agent-task',
        title: 'Native sub-agent dispatch',
        startedAt: new Date(startedAt),
        endedAt,
        nativeActivityAt: endedAt,
        durationMs: Math.max(0, endedAt.getTime() - startedAt),
        metadata: {
          source: NATIVE_SOURCE,
          nativeCoverage: { source: 'dispatcher-return', realtime: false },
          capturePolicy: {
            source: 'native-persistence-no-invocation-snapshot',
            sharing: 'disabled',
            captureInputs: false,
            captureOutputs: false,
            redactSecrets: true,
          },
          dispatchToolMessageId: dispatch.id,
          dispatchMessageId: dispatch.messageId,
          harnessTag: settings.harnessTag || 'default',
          outcome: status,
        },
        userId: task.ctx.auth?.user?.id,
      });
      if (!span) this.warn('[AgentOrchestrator] Native dispatch telemetry was not persisted.');
    } catch (error) {
      this.warn('[AgentOrchestrator] Native dispatch telemetry failed; continuing native execution.', error);
    }
  }

  private async resolveDispatch(parentSessionId: string, subSessionId: string, db?: NativeContext['db']) {
    if (!parentSessionId || !subSessionId) return null;
    const messages = await this.findMany(db, 'aiMessages', {
      filter: { sessionId: parentSessionId },
      sort: ['-messageId'],
      limit: 100,
    });
    for (const message of messages) {
      const relations = asObject(readValue(message, 'metadata')).subAgentConversations;
      if (!Array.isArray(relations)) continue;
      const relation = relations.find((value) => stringValue(asObject(value).sessionId) === subSessionId);
      const toolCallId = stringValue(asObject(relation).toolCallId);
      if (toolCallId) {
        return {
          id: undefined,
          messageId: stringValue(readValue(message, 'messageId')),
          toolCallId,
        };
      }
    }

    const toolMessage = await this.findOne(db, 'aiToolMessages', {
      filter: { sessionId: parentSessionId, toolName: 'dispatch-sub-agent-task' },
      sort: ['-id'],
    });
    const contentSessionId = stringValue(asObject(readValue(toolMessage, 'content')).sessionId);
    return contentSessionId === subSessionId
      ? {
          id: readValue(toolMessage, 'id'),
          messageId: stringValue(readValue(toolMessage, 'messageId')),
          toolCallId: stringValue(readValue(toolMessage, 'toolCallId')),
        }
      : null;
  }

  private async findParentSpan(parentConversation: Record<string, unknown> | null, parentSessionId: string) {
    const from = stringValue(readValue(parentConversation, 'from'));
    if (from === 'sub-agent') {
      return this.findOne(this.plugin.db, 'agentExecutionSpans', {
        filter: { source: NATIVE_SOURCE, type: 'sub_agent', subSessionId: parentSessionId },
      });
    }
    return this.findOne(this.plugin.db, 'agentExecutionSpans', {
      filter: { source: NATIVE_SOURCE, type: 'main_agent', parentSessionId },
    });
  }

  private async findOne(
    database: NativeContext['db'] | ObserverPlugin['db'],
    name: string,
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    try {
      const row = await database?.getRepository?.(name)?.findOne?.(options);
      return row ? rowAsObject(row) : null;
    } catch {
      return null;
    }
  }

  private async findMany(database: NativeContext['db'] | undefined, name: string, options: Record<string, unknown>) {
    try {
      const rows = await database?.getRepository?.(name)?.find?.(options);
      return Array.isArray(rows) ? rows.map(rowAsObject) : [];
    } catch {
      return [];
    }
  }

  private info(message: string) {
    try {
      this.plugin.app.logger?.info?.(message);
    } catch {
      // Telemetry logging is best effort.
    }
  }

  private warn(message: string, error?: unknown) {
    try {
      this.plugin.app.logger?.warn?.(message, { error });
    } catch {
      // Telemetry logging must not affect native execution.
    }
  }
}

export { makeNativeRunId };
