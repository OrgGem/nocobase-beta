import { describe, expect, it, vi } from 'vitest';
import { AgentMemoryContextService } from '../services/AgentMemoryContextService';
import { NativeSubAgentObserver } from '../services/NativeSubAgentObserver';

function createObserverHarness(
  profileSettings: Record<string, unknown> | null = {},
  options: {
    memoryRows?: unknown[];
    orchestratorConfig?: unknown;
    knowledgeBasePlugin?: unknown;
  } = {},
) {
  let nextSpanId = 1;
  const spanRepo = {
    create: vi.fn(async ({ values }) => ({ id: nextSpanId++, ...values })),
    update: vi.fn(async () => ({})),
  };
  const originalRun = vi.fn(async (task) => {
    task.writer?.({
      action: 'beforeToolCall',
      body: {
        toolCall: {
          id: 'tool-1',
          name: 'skill_hub_execute',
          args: { input: 'x' },
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
        toolCallResult: {
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
    return `answer:${task.question}`;
  });
  const dispatcher = { run: originalRun };
  const repos: Record<string, unknown> = {
    agentExecutionSpans: spanRepo,
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
          ? { sessionId: 'parent-session', aiEmployeeUsername: 'leader', userId: 7 }
          : null,
      ),
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

  return { plugin, dispatcher, originalRun, spanRepo, repos };
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
