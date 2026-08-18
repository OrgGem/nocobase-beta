import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'fs';
import { AgentMemoryContextService } from '../services/AgentMemoryContextService';
import { compileHarness } from '../services/HarnessCompiler';
import { NativeSubAgentObserver } from '../services/NativeSubAgentObserver';
import { getAgentExecutionContext } from '../services/AgentExecutionContext';
import { REDACTED_PLACEHOLDER } from '../services/harness-runtime-policy';

// The observer spills oversized sub-agent results to storage; keep tests side-effect free.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

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

describe('NativeSubAgentObserver', () => {
  it('wraps dispatcher once and calls the original native run', async () => {
    const { plugin, dispatcher, originalRun, spanRepo } = createObserverHarness();
    const observer = new NativeSubAgentObserver(plugin);

    expect(observer.install()).toBe(true);
    expect(observer.install()).toBe(false);

    const result = await dispatcher.run(createTask());

    expect(result).toBe('answer:do the work');
    expect(originalRun).toHaveBeenCalledTimes(1);
    expect(spanRepo.create).toHaveBeenCalled();
    expect(spanRepo.update).toHaveBeenCalled();
  });

  it('uses the sub-agent employee bindings instead of inheriting the leader tool filter', async () => {
    const { plugin, dispatcher, getObserved } = createObserverHarness();
    const observer = new NativeSubAgentObserver(plugin);
    observer.install();

    await dispatcher.run(createTask());

    expect(getObserved()).toEqual({ observedIdentity: 'sub-agent', observedSkillSettings: undefined });
  });

  it('links a completed Skill Hub execution to its native tool span', async () => {
    const { plugin, dispatcher, skillExecutionRepo } = createObserverHarness(
      {},
      {
        toolCallResult: {
          status: 'success',
          content: JSON.stringify({ execId: 'execution-41' }),
        },
      },
    );
    const observer = new NativeSubAgentObserver(plugin);
    observer.install();

    await dispatcher.run(createTask());

    expect(skillExecutionRepo.update).toHaveBeenCalledWith({
      filterByTk: 'execution-41',
      values: { orchestratorSpanId: 2 },
    });
  });

  it('restores the native dispatcher when uninstalled', async () => {
    const { plugin, dispatcher, originalRun } = createObserverHarness();
    const observer = new NativeSubAgentObserver(plugin);

    observer.install();
    expect(dispatcher.run).not.toBe(originalRun);

    expect(observer.uninstall()).toBe(true);
    await dispatcher.run(createTask());
    expect(originalRun).toHaveBeenCalledTimes(1);
    expect(observer.uninstall()).toBe(false);
  });

  it('maps dispatch toolCallId from native sub-agent metadata by sub-session', async () => {
    const { plugin, dispatcher, spanRepo, repos } = createObserverHarness();
    repos.aiMessages = {
      find: vi.fn(async () => [
        {
          messageId: 30,
          metadata: {
            subAgentConversations: [
              { sessionId: 'other-sub-session', toolCallId: 'other-dispatch-call', status: 'pending' },
              { sessionId: 'sub-session', toolCallId: 'metadata-dispatch-call', status: 'pending' },
            ],
          },
        },
      ]),
    };
    repos.aiToolMessages = {
      findOne: vi.fn(async ({ filter }) => ({
        id: 11,
        messageId: 30,
        toolCallId: filter.toolCallId,
        sessionId: filter.sessionId,
      })),
    };
    const observer = new NativeSubAgentObserver(plugin);
    observer.install();

    await dispatcher.run(createTask(plugin.db.getRepository));

    const rootSpanValues = spanRepo.create.mock.calls[0][0].values;
    expect(rootSpanValues.toolCallId).toBe('metadata-dispatch-call');
    expect(rootSpanValues.metadata.dispatchToolMessageId).toBe(11);
  });

  it('bypasses tracing and injection when policy disables the native observer', async () => {
    const { plugin, dispatcher, originalRun, spanRepo } = createObserverHarness({ nativeObserverEnabled: false });
    const observer = new NativeSubAgentObserver(plugin);
    observer.install();

    await dispatcher.run(createTask());

    expect(originalRun).toHaveBeenCalledTimes(1);
    expect(originalRun.mock.calls[0][0].question).toBe('do the work');
    expect(spanRepo.create).not.toHaveBeenCalled();
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

describe('NativeSubAgentObserver memory injection', () => {
  it('places reference memory before the immutable agent task', async () => {
    const { plugin, dispatcher, originalRun } = createObserverHarness(
      {},
      {
        memoryRows: [{ scope: 'public', enabled: true, userId: null, contentMd: 'Reference fact' }],
      },
    );
    const observer = new NativeSubAgentObserver(plugin);
    observer.install();

    await dispatcher.run(createTask());

    const question = originalRun.mock.calls[0][0].question as string;
    expect(question).toContain('<agent_memory_context>');
    expect(question).toContain('<agent_task>\ndo the work\n</agent_task>');
    expect(question.indexOf('Reference fact')).toBeLessThan(question.indexOf('<agent_task>'));
  });

  it('runs the native sub-agent with its Knowledge Base request identity', async () => {
    const runWithAgentContext = vi.fn(async (_username: string, callback: () => Promise<string>) => callback());
    const { plugin, dispatcher } = createObserverHarness({}, { knowledgeBasePlugin: { runWithAgentContext } });
    const observer = new NativeSubAgentObserver(plugin);
    observer.install();

    await dispatcher.run(createTask());

    expect(runWithAgentContext).toHaveBeenCalledWith('sub-agent', expect.any(Function));
  });
});

describe('NativeSubAgentObserver harness policy', () => {
  beforeEach(() => {
    vi.mocked(writeFileSync).mockClear();
  });

  it('persists no spans at all when sharing is disabled', async () => {
    const { plugin, dispatcher, originalRun, spanRepo } = createObserverHarness({
      observability: { sharing: 'disabled' },
    });
    const observer = new NativeSubAgentObserver(plugin);
    observer.install();

    const result = await dispatcher.run(createTask());

    expect(result).toBe('answer:do the work');
    expect(originalRun).toHaveBeenCalledTimes(1);
    expect(spanRepo.create).not.toHaveBeenCalled();
    expect(spanRepo.update).not.toHaveBeenCalled();
  });

  it('captures outputs but omits inputs under feedback-only sharing', async () => {
    const { plugin, dispatcher, spanRepo } = createObserverHarness({
      observability: { sharing: 'feedback-only' },
    });
    const observer = new NativeSubAgentObserver(plugin);
    observer.install();

    await dispatcher.run(createTask());

    const rootSpanValues = spanRepo.create.mock.calls[0][0].values;
    const toolSpanValues = spanRepo.create.mock.calls[1][0].values;
    expect(rootSpanValues.input).toBeUndefined();
    expect(toolSpanValues.input).toBeUndefined();
    const toolSpanUpdate = spanRepo.update.mock.calls[0][0].values;
    expect(toolSpanUpdate.output).toBeDefined();
  });

  it('redacts secret-looking keys in captured tool args by default', async () => {
    const { plugin, dispatcher, spanRepo } = createObserverHarness(
      {},
      { toolCallArgs: { apiKey: 'secret-value', path: '/tmp/x' } },
    );
    const observer = new NativeSubAgentObserver(plugin);
    observer.install();

    await dispatcher.run(createTask());

    const toolSpanValues = spanRepo.create.mock.calls[1][0].values;
    expect(toolSpanValues.input).toEqual({ apiKey: REDACTED_PLACEHOLDER, path: '/tmp/x' });
  });

  it('keeps raw tool args when the profile disables redaction', async () => {
    const { plugin, dispatcher, spanRepo } = createObserverHarness(
      { observability: { redactSecrets: false } },
      { toolCallArgs: { apiKey: 'secret-value' } },
    );
    const observer = new NativeSubAgentObserver(plugin);
    observer.install();

    await dispatcher.run(createTask());

    const toolSpanValues = spanRepo.create.mock.calls[1][0].values;
    expect(toolSpanValues.input).toEqual({ apiKey: 'secret-value' });
  });

  it('spills oversized sub-agent results to disk and returns a bounded preview', async () => {
    const longAnswer = `ANSWER-HEAD ${'y'.repeat(6000)} ANSWER-TAIL`;
    const { plugin, dispatcher, spanRepo } = createObserverHarness(
      { context: { spill: { maxInlineBytes: 400 } } },
      { runResult: longAnswer },
    );
    const observer = new NativeSubAgentObserver(plugin);
    observer.install();

    const result = await dispatcher.run(createTask());

    expect(result).toContain('ANSWER-HEAD');
    expect(result).toContain('ANSWER-TAIL');
    expect(result).toContain('bytes omitted');
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(400);
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const spillPath = vi.mocked(writeFileSync).mock.calls[0][0] as string;
    expect(spillPath).toContain('spills');
    // The root span (created first, id 1) stores the spilled preview, not the full text.
    const rootSpanUpdate = spanRepo.update.mock.calls.map((call) => call[0]).find((values) => values.filterByTk === 1);
    expect(rootSpanUpdate.values.output).toBe(result);
  });

  it('keeps small results inline when no spill budget is configured', async () => {
    const { plugin, dispatcher } = createObserverHarness({}, { runResult: 'short answer' });
    const observer = new NativeSubAgentObserver(plugin);
    observer.install();

    const result = await dispatcher.run(createTask());

    expect(result).toBe('short answer');
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});

describe('NativeSubAgentObserver delegation inheritance', () => {
  function loopParentConversation() {
    return {
      sessionId: 'parent-session',
      aiEmployeeUsername: 'leader',
      userId: 7,
      options: { controlPlaneRunId: 5 },
    };
  }

  function loopRunHarness(settings: Record<string, unknown>) {
    return {
      id: 5,
      roleBindingsSnapshot: { leader: 'leader' },
      leaderHarnessSnapshot: {
        effective: compileHarness([{ source: 'run-snapshot', settings }]),
      },
    };
  }

  it('inherits the loop role harness as an extra compile layer', async () => {
    const { plugin, dispatcher, spanRepo } = createObserverHarness(
      {},
      {
        parentConversation: loopParentConversation(),
        loopRuns: {
          5: loopRunHarness({
            observability: { sharing: 'feedback-only' },
            delegation: { maxDepth: 4 },
          }),
        },
      },
    );
    const observer = new NativeSubAgentObserver(plugin);
    observer.install();

    await dispatcher.run(createTask(plugin.db.getRepository));

    const rootSpanValues = spanRepo.create.mock.calls[0][0].values;
    // The parent layer tightens sharing to feedback-only even though the child profile defaults
    // to full; the run linkage is persisted on the span and in its metadata.
    expect(rootSpanValues.input).toBeUndefined();
    expect(rootSpanValues.depth).toBe(1);
    expect(rootSpanValues.agentLoopRunId).toBe(5);
    expect(rootSpanValues.metadata.agentLoopRunId).toBe(5);
  });

  it('does not inherit a run harness when the parent conversation is not a loop session', async () => {
    const { plugin, dispatcher, spanRepo, repos } = createObserverHarness(
      {},
      {
        loopRuns: { 5: loopRunHarness({ observability: { sharing: 'feedback-only' } }) },
      },
    );
    const observer = new NativeSubAgentObserver(plugin);
    observer.install();

    await dispatcher.run(createTask(plugin.db.getRepository));

    const rootSpanValues = spanRepo.create.mock.calls[0][0].values;
    // Full sharing from the child profile: without controlPlaneRunId no parent layer is applied.
    expect(rootSpanValues.input).toBeDefined();
    expect(rootSpanValues.agentLoopRunId).toBeUndefined();
    const runRepo = repos.agentLoopRuns as { findOne: ReturnType<typeof vi.fn> };
    expect(runRepo.findOne).not.toHaveBeenCalled();
  });

  it('derives the child depth from the parent span persisted in the database', async () => {
    const { plugin, dispatcher, spanRepo } = createObserverHarness(
      {},
      {
        spanFindOne: async (query) => (query.filter?.subSessionId === 'parent-session' ? { id: 99, depth: 2 } : null),
      },
    );
    const observer = new NativeSubAgentObserver(plugin);
    observer.install();

    await dispatcher.run(createTask());

    const rootSpanValues = spanRepo.create.mock.calls[0][0].values;
    expect(rootSpanValues.depth).toBe(3);
    expect(rootSpanValues.parentSpanId).toBe('99');
  });

  it('fails the dispatch when the child depth exceeds the inherited maxDepth', async () => {
    const { plugin, dispatcher, originalRun, spanRepo } = createObserverHarness(
      {},
      {
        parentConversation: loopParentConversation(),
        loopRuns: { 5: loopRunHarness({ delegation: { maxDepth: 2 } }) },
        spanFindOne: async (query) => (query.filter?.subSessionId === 'parent-session' ? { id: 99, depth: 2 } : null),
      },
    );
    const observer = new NativeSubAgentObserver(plugin);
    observer.install();

    await expect(dispatcher.run(createTask(plugin.db.getRepository))).rejects.toThrow(
      'delegation depth 3 exceeds the harness limit of 2',
    );
    expect(originalRun).not.toHaveBeenCalled();
    const rootSpanUpdate = spanRepo.update.mock.calls.map((call) => call[0]).find((values) => values.filterByTk === 1);
    expect(rootSpanUpdate.values.status).toBe('error');
    expect(rootSpanUpdate.values.error).toContain('exceeds the harness limit');
  });
});
