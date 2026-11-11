/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import { AgentMemoryContextService } from '../services/AgentMemoryContextService';
import { NativeSubAgentObserver } from '../services/NativeSubAgentObserver';
import { getAgentExecutionContext } from '../services/AgentExecutionContext';
function createObserverHarness(
  profileSettings: Record<string, unknown> | null = {},
  options: {
    memoryRows?: unknown[];
    orchestratorConfig?: unknown;
    knowledgeBasePlugin?: unknown;
    toolCallResult?: unknown;
    toolCallArgs?: Record<string, unknown>;
    runResult?: string;
    parentConversation?: Record<string, unknown>;
    loopRuns?: Record<number, Record<string, unknown>>;
    spanFindOne?: (query: {
      filterByTk?: string | number;
      filter?: Record<string, unknown>;
    }) => Promise<Record<string, unknown> | null>;
  } = {},
) {
  let nextSpanId = 1;
  let observedIdentity: string | undefined;
  let observedSkillSettings: unknown;
  const spanRepo = {
    create: vi.fn(async ({ values }) => ({ id: nextSpanId++, ...values })),
    update: vi.fn(async () => ({})),
    findOne: options.spanFindOne ? vi.fn(options.spanFindOne) : undefined,
  };
  const skillExecutionRepo = {
    update: vi.fn(async () => ({})),
  };
  const originalRun = vi.fn(async (task) => {
    observedIdentity = getAgentExecutionContext()?.employeeUsername;
    observedSkillSettings = task.skillSettings;
    task.writer?.({
      action: 'beforeToolCall',
      body: {
        toolCall: {
          id: 'tool-1',
          name: 'skill_hub_execute',
          args: options.toolCallArgs ?? { input: 'x' },
          messageId: 'msg-1',
        },
      },
      currentConversation: {
        sessionId: 'sub-session',
        username: 'sub-agent',
        from: 'sub-agent',
      },
    });
    task.writer?.({
      action: 'afterToolCall',
      body: {
        toolCall: {
          id: 'tool-1',
          name: 'skill_hub_execute',
          messageId: 'msg-1',
        },
        toolCallResult: options.toolCallResult ?? {
          status: 'success',
          content: { ok: true },
        },
      },
      currentConversation: {
        sessionId: 'sub-session',
        username: 'sub-agent',
        from: 'sub-agent',
      },
    });
    return options.runResult ?? `answer:${task.question}`;
  });
  const dispatcher = { run: originalRun };
  const repos: Record<string, unknown> = {
    agentExecutionSpans: spanRepo,
    skillExecutions: skillExecutionRepo,
    agentHarnessProfiles: {
      findOne: vi.fn(async () => (profileSettings ? { settings: profileSettings } : null)),
    },
    agentMemoryContexts: {
      find: vi.fn(async () => options.memoryRows ?? []),
    },
    aiToolMessages: {
      findOne: vi.fn(async () => ({
        id: 10,
        messageId: 20,
        toolCallId: 'dispatch-call',
        sessionId: 'parent-session',
      })),
    },
    aiConversations: {
      findOne: vi.fn(async ({ filter }) =>
        filter?.sessionId === 'parent-session'
          ? options.parentConversation ?? { sessionId: 'parent-session', aiEmployeeUsername: 'leader', userId: 7 }
          : null,
      ),
    },
    agentLoopRuns: {
      findOne: vi.fn(async ({ filterByTk }) => options.loopRuns?.[Number(filterByTk)] ?? null),
    },
    orchestratorConfig: {
      findOne: vi.fn(async () => options.orchestratorConfig ?? null),
    },
  };
  const plugin = {
    app: {
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
      pm: {
        get: vi.fn((name) => {
          if (name === 'ai') return { subAgentsDispatcher: dispatcher };
          if (name === 'plugin-knowledge-base') return options.knowledgeBasePlugin ?? null;
          return null;
        }),
        getPlugins: vi.fn(() => new Map()),
      },
    },
    db: {
      getRepository: vi.fn((name) => repos[name]),
    },
  };

  return {
    plugin,
    dispatcher,
    originalRun,
    spanRepo,
    skillExecutionRepo,
    repos,
    getObserved: () => ({ observedIdentity, observedSkillSettings }),
  };
}

function createTask(getRepository?: (name: string) => unknown) {
  return {
    ctx: {
      action: {
        params: {
          values: {
            sessionId: 'parent-session',
          },
        },
      },
      auth: {
        user: { id: 7 },
      },
      db: {
        getRepository: getRepository || vi.fn(),
      },
    },
    sessionId: 'sub-session',
    employee: { username: 'sub-agent' },
    skillSettings: { tools: [{ name: 'skill_hub_leader_only' }] },
    question: 'do the work',
  };
}

type TransparentTask = {
  ctx: {
    action: { params: { values: { sessionId: string } } };
    auth: { user: { id: number } };
    db: { getRepository: (name: string) => undefined };
  };
  sessionId: string;
  employee: { username: string };
  model: { name: string };
  question: string;
  skillSettings: { tools: readonly { name: string }[] };
  writer: (chunk: Record<string, unknown>) => undefined;
};

type ObserverTestSeam = {
  observeDispatch: (task: TransparentTask, status: 'success' | 'error', startedAt: number) => Promise<void>;
};

function createTransparentObserverHarness(run: (task: TransparentTask) => Promise<string>) {
  const writer = vi.fn(() => undefined);
  const skillSettings = Object.freeze({ tools: Object.freeze([{ name: 'native-tool' }]) });
  const task: TransparentTask = Object.freeze({
    ctx: {
      action: { params: { values: { sessionId: 'parent-session' } } },
      auth: { user: { id: 7 } },
      db: { getRepository: vi.fn(() => undefined) },
    },
    sessionId: 'child-session',
    employee: { username: 'sub-agent' },
    model: { name: 'native-model' },
    question: 'preserve this prompt',
    skillSettings,
    writer,
  });
  const originalRun = vi.fn(run);
  const dispatcher = { run: originalRun };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const plugin = {
    app: {
      logger,
      pm: { get: vi.fn((name: string) => (name === 'ai' ? { subAgentsDispatcher: dispatcher } : null)) },
    },
    db: { getRepository: vi.fn(() => undefined) },
  };
  const observer = new NativeSubAgentObserver(
    plugin as unknown as ConstructorParameters<typeof NativeSubAgentObserver>[0],
  );
  return { observer, dispatcher, originalRun, logger, task };
}
describe('NativeSubAgentObserver', () => {
  it('passes the original native task, writer and skill bindings through unchanged', async () => {
    const writer = vi.fn(() => undefined);
    const skillSettings = Object.freeze({ tools: Object.freeze([{ name: 'native-tool' }]) });
    const task = Object.freeze({
      ctx: {
        action: { params: { values: { sessionId: 'parent-session' } } },
        auth: { user: { id: 7 } },
        db: { getRepository: vi.fn(() => undefined) },
      },
      sessionId: 'child-session',
      employee: { username: 'sub-agent' },
      model: { name: 'native-model' },
      question: 'preserve this prompt',
      skillSettings,
      writer,
    });
    const nativeResult = 'native-result';
    const originalRun = vi.fn(async (_task: typeof task) => nativeResult);
    const dispatcher = { run: originalRun };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const plugin = {
      app: {
        logger,
        pm: { get: vi.fn((name: string) => (name === 'ai' ? { subAgentsDispatcher: dispatcher } : null)) },
      },
      db: { getRepository: vi.fn(() => undefined) },
    };
    const observer = new NativeSubAgentObserver(
      plugin as unknown as ConstructorParameters<typeof NativeSubAgentObserver>[0],
    );
    const telemetry = vi.spyOn(observer as unknown as ObserverTestSeam, 'observeDispatch').mockResolvedValue(undefined);

    expect(observer.install()).toBe(true);
    const result = await dispatcher.run(task);

    expect(originalRun).toHaveBeenCalledTimes(1);
    expect(originalRun.mock.calls[0][0]).toBe(task);
    expect(originalRun.mock.calls[0][0].writer).toBe(writer);
    expect(originalRun.mock.calls[0][0].skillSettings).toBe(skillSettings);
    expect(originalRun.mock.calls[0][0].question).toBe('preserve this prompt');
    expect(result).toBe(nativeResult);
    expect(telemetry).toHaveBeenCalledWith(task, 'success', expect.any(Number));
  });

  it('does not block or replace a native result when telemetry rejects or stalls', async () => {
    const failure = new Error('telemetry persistence failed');
    const rejecting = createTransparentObserverHarness(async () => 'completed');
    const rejectingTelemetry = vi
      .spyOn(rejecting.observer as unknown as ObserverTestSeam, 'observeDispatch')
      .mockRejectedValue(failure);
    expect(rejecting.observer.install()).toBe(true);
    expect(await rejecting.dispatcher.run(rejecting.task)).toBe('completed');
    expect(rejecting.originalRun.mock.calls[0][0]).toBe(rejecting.task);
    await vi.waitFor(() => {
      expect(rejecting.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('telemetry failed; continuing native execution'),
        { error: failure },
      );
    });
    expect(rejectingTelemetry).toHaveBeenCalledWith(rejecting.task, 'success', expect.any(Number));

    const stalled = createTransparentObserverHarness(async () => 'still completed');
    vi.spyOn(stalled.observer as unknown as ObserverTestSeam, 'observeDispatch').mockReturnValue(
      new Promise<void>(() => {}),
    );
    expect(stalled.observer.install()).toBe(true);
    await expect(stalled.dispatcher.run(stalled.task)).resolves.toBe('still completed');
  });

  it('preserves the original native error when telemetry also fails', async () => {
    const nativeError = new Error('native dispatch failed');
    const telemetryError = new Error('telemetry write failed');
    const harness = createTransparentObserverHarness(async () => {
      throw nativeError;
    });
    const telemetry = vi
      .spyOn(harness.observer as unknown as ObserverTestSeam, 'observeDispatch')
      .mockRejectedValue(telemetryError);
    expect(harness.observer.install()).toBe(true);

    await expect(harness.dispatcher.run(harness.task)).rejects.toBe(nativeError);
    expect(harness.originalRun.mock.calls[0][0]).toBe(harness.task);
    expect(telemetry).toHaveBeenCalledWith(harness.task, 'error', expect.any(Number));
    await vi.waitFor(() => {
      expect(harness.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('telemetry failed; continuing native execution'),
        { error: telemetryError },
      );
    });
  });

  it('installs once and restores the native dispatcher', async () => {
    const harness = createTransparentObserverHarness(async () => 'native');
    const originalRun = harness.dispatcher.run;
    expect(harness.observer.install()).toBe(true);
    const wrappedRun = harness.dispatcher.run;
    expect(wrappedRun).not.toBe(originalRun);
    expect(harness.observer.install()).toBe(false);
    expect(harness.observer.uninstall()).toBe(true);
    expect(harness.dispatcher.run).not.toBe(wrappedRun);
    expect(harness.observer.uninstall()).toBe(false);

    await harness.dispatcher.run(harness.task);
    expect(originalRun).toHaveBeenCalledTimes(1);
  });
});
describe('AgentMemoryContextService', () => {
  it('prioritizes agent-user context before user and public memory', async () => {
    const rows = [
      { scope: 'public', enabled: true, userId: null, aiEmployeeUsername: '', contentMd: 'Public fact' },
      { scope: 'user', enabled: true, userId: 7, aiEmployeeUsername: '', contentMd: 'User context' },
      { scope: 'agent_user', enabled: true, userId: 7, aiEmployeeUsername: 'sub-agent', contentMd: 'Private graph' },
      { scope: 'agent_user', enabled: true, userId: 8, aiEmployeeUsername: 'sub-agent', contentMd: 'Other private' },
    ];
    const plugin = {
      app: {
        logger: { warn: vi.fn() },
        pm: {
          get: vi.fn((name) =>
            name === 'plugin-user-memory'
              ? {
                  memoryInjector: {
                    getMemoryPromptSection: vi.fn(async () => '<user_memory>User profile</user_memory>'),
                  },
                }
              : null,
          ),
        },
      },
      db: {
        getRepository: vi.fn((name) => {
          if (name === 'agentMemoryContexts') {
            return {
              find: vi.fn(async ({ filter }) =>
                rows.filter(
                  (row) =>
                    row.scope === filter.scope &&
                    row.enabled === filter.enabled &&
                    (filter.userId === undefined || row.userId === filter.userId),
                ),
              ),
            };
          }
          return null;
        }),
      },
    };
    const service = new AgentMemoryContextService(plugin);

    const result = await service.buildContext({
      userId: 7,
      aiEmployeeUsername: 'sub-agent',
      settings: { memoryScopes: ['public', 'user', 'agent_user'], maxMemoryContextChars: 10000 },
    });

    expect(result.appliedScopes).toEqual(['agent_user', 'user-memory', 'user', 'public']);
    expect(result.context.indexOf('Private graph')).toBeLessThan(result.context.indexOf('<user_memory>'));
    expect(result.context.indexOf('<user_memory>')).toBeLessThan(result.context.indexOf('User context'));
    expect(result.context.indexOf('User context')).toBeLessThan(result.context.indexOf('Public fact'));
    expect(result.context).not.toContain('Other private');
  });

  it('does not inject any memory when a profile explicitly selects no scopes', async () => {
    const plugin = {
      app: { logger: { warn: vi.fn() }, pm: { get: vi.fn() } },
      db: {
        getRepository: vi.fn(() => ({
          find: vi.fn(async () => [{ scope: 'public', enabled: true, userId: null, contentMd: 'Public fact' }]),
        })),
      },
    };
    const service = new AgentMemoryContextService(plugin);

    await expect(
      service.buildContext({
        userId: 7,
        aiEmployeeUsername: 'sub-agent',
        settings: { memoryScopes: [] },
      }),
    ).resolves.toEqual({ context: '', appliedScopes: [], chars: 0 });
  });

  it('uses the leader-to-sub-agent harness tag when no explicit tag is supplied', async () => {
    const { plugin } = createObserverHarness(null, {
      orchestratorConfig: { harnessTag: 'safe' },
    });
    const profileRepo = plugin.db.getRepository('agentHarnessProfiles') as {
      findOne: ReturnType<typeof vi.fn>;
    };
    profileRepo.findOne.mockImplementation(async ({ filter }: { filter: { tag: string } }) =>
      filter.tag === 'safe' ? { settings: { maxMemoryContextChars: 1200 } } : null,
    );
    const service = new AgentMemoryContextService(plugin);

    await expect(
      service.resolvePolicySettings({ ctx: createTask().ctx, employee: { username: 'sub-agent' } }),
    ).resolves.toEqual(expect.objectContaining({ harnessTag: 'safe', maxMemoryContextChars: 1200 }));
  });

  it('prefers the published version over raw row settings and flattens the contract', async () => {
    const versionSettings = {
      memory: { enabled: true, scopes: ['public'], maxChars: 1500 },
      observability: { enabled: true, tracingRetentionDays: 7 },
    };
    const plugin = {
      app: { logger: { warn: vi.fn() }, pm: { get: vi.fn() } },
      db: {
        getRepository: vi.fn((name: string) => {
          if (name === 'agentHarnessProfiles') {
            return {
              findOne: vi.fn(async ({ filter }: { filter: { tag: string } }) =>
                filter.tag === 'strict' ? { id: 1, tag: 'strict', enabled: true, currentVersionId: 5 } : null,
              ),
            };
          }
          if (name === 'agentHarnessProfileVersions') {
            return {
              findOne: vi.fn(async ({ filter }: { filter: { id: number; status: string } }) =>
                filter.id === 5 && filter.status === 'published'
                  ? {
                      id: 5,
                      profileId: 1,
                      version: 2,
                      schemaVersion: 1,
                      status: 'published',
                      settings: versionSettings,
                    }
                  : null,
              ),
            };
          }
          return null;
        }),
      },
    };
    const service = new AgentMemoryContextService(plugin);

    const settings = await service.resolvePolicySettings({
      ctx: { action: { params: { values: { harnessTag: 'strict' } } } },
      employee: { username: 'sub-agent' },
    });

    expect(settings).toMatchObject({
      harnessTag: 'strict',
      memoryInjectionEnabled: true,
      memoryScopes: ['public'],
      maxMemoryContextChars: 1500,
      nativeObserverEnabled: true,
      tracingRetentionDays: 7,
    });
  });
});
