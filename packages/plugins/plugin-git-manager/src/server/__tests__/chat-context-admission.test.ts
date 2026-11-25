// SPDX-License-Identifier: Apache-2.0

import type { Context } from '@nocobase/actions';
import { enforceGitChatAdmission, registerGitChatContextStrategies } from '../chat-context-admission';

const mocks = vi.hoisted(() => ({ loadChatContext: vi.fn() }));

vi.mock('../actions/chat-context', () => ({ loadChatContext: mocks.loadChatContext }));

type GitContext = { type: string; uid: string; title?: string; content?: unknown };

function createApp(aiPlugin?: unknown) {
  return {
    pm: {
      get: vi.fn((name: string) => (name === 'ai' ? aiPlugin : undefined)),
    },
  };
}

function createContext(input: {
  app: ReturnType<typeof createApp>;
  actionName: string;
  values: Record<string, unknown>;
  messagesRepository?: { findOne: ReturnType<typeof vi.fn> };
  userId?: number;
}) {
  const next = vi.fn().mockResolvedValue(undefined);
  const throwError = vi.fn((status: number, message: string): never => {
    throw Object.assign(new Error(message), { status });
  });
  const getRepository = vi.fn(() => input.messagesRepository);
  const context = {
    action: { resourceName: 'aiConversations', actionName: input.actionName, params: { values: input.values } },
    app: input.app,
    auth: { user: { id: input.userId ?? 21 } },
    db: { getRepository },
    state: { currentRoles: ['developer'], currentUser: { id: input.userId ?? 21 } },
    t: (value: string) => value,
    throw: throwError,
  };
  return { context: context as unknown as Context, next, throwError, getRepository };
}

function contextItem(overrides: Partial<GitContext> = {}): GitContext {
  return {
    type: 'git-commit',
    uid: `7:${'a'.repeat(40)}`,
    title: 'Old Repository · aaaaaaa · stale title',
    ...overrides,
  };
}

describe('Git AI chat context admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rehydrates client supplied content and title before a message is sent', async () => {
    const freshContent = {
      type: 'git-commit',
      repositoryId: 7,
      repositoryName: 'permitted-repository',
      commitSha: 'a'.repeat(40),
      subject: 'Fix permission check',
      diff: '+fresh data',
    };
    mocks.loadChatContext.mockResolvedValue(freshContent);
    const aiPlugin = { workContextHandler: { registerStrategy: vi.fn() } };
    const app = createApp(aiPlugin);
    const item = contextItem({ content: { diff: '+forged data' } });
    const values = { messages: [{ role: 'user', workContext: [item] }] };
    const { context, next } = createContext({ app, actionName: 'sendMessages', values });

    await enforceGitChatAdmission(context, next);

    expect(mocks.loadChatContext).toHaveBeenCalledWith(context, {
      kind: 'commit',
      repositoryId: '7',
      commitHash: 'a'.repeat(40),
    });
    expect(values.messages[0].workContext[0]).toMatchObject({
      type: 'git-commit',
      uid: `7:${'a'.repeat(40)}`,
      title: 'permitted-repository · aaaaaaa · Fix permission check',
      content: freshContent,
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('blocks sending when access was revoked after a context tag had been selected', async () => {
    mocks.loadChatContext.mockRejectedValue(Object.assign(new Error('Permission denied'), { status: 403 }));
    const app = createApp({ workContextHandler: { registerStrategy: vi.fn() } });
    const values = { messages: [{ role: 'user', workContext: [contextItem({ content: { diff: '+stale data' } })] }] };
    const { context, next, throwError } = createContext({ app, actionName: 'sendMessages', values });

    await expect(enforceGitChatAdmission(context, next)).rejects.toMatchObject({ status: 403 });

    expect(throwError).toHaveBeenCalledWith(403, 'Git context is unavailable. Check your access and select it again.');
    expect(next).not.toHaveBeenCalled();
  });

  it('checks resend session ownership before reading messages and rehydrates the latest user tag', async () => {
    const workContext = [contextItem({ content: { diff: '+old content' } })];
    const messageId = '9007199254740992';
    const targetMessage = {
      get: (field: string) => (field === 'messageId' ? messageId : field === 'role' ? 'assistant' : null),
    };
    const priorUserMessage = {
      get: (field: string) =>
        field === 'messageId'
          ? '9007199254740991'
          : field === 'role'
            ? 'user'
            : field === 'workContext'
              ? workContext
              : null,
    };
    const messagesRepository = {
      findOne: vi.fn().mockResolvedValueOnce(targetMessage).mockResolvedValueOnce(priorUserMessage),
    };
    const aiPlugin = {
      workContextHandler: { registerStrategy: vi.fn() },
      aiConversationsManager: { getConversation: vi.fn().mockResolvedValue({ sessionId: 'session-1' }) },
    };
    const app = createApp(aiPlugin);
    const values = { sessionId: 'session-1', messageId };
    const { context, next, getRepository } = createContext({
      app,
      actionName: 'resendMessages',
      values,
      messagesRepository,
    });
    mocks.loadChatContext.mockResolvedValue({
      type: 'git-commit',
      repositoryId: 7,
      repositoryName: 'permitted-repository',
      commitSha: 'a'.repeat(40),
      subject: 'Current commit title',
      diff: '+current content',
    });

    await enforceGitChatAdmission(context, next);

    const manager = aiPlugin.aiConversationsManager;
    expect(manager.getConversation).toHaveBeenCalledWith({ sessionId: 'session-1', userId: 21 });
    expect(getRepository).toHaveBeenCalledWith('aiConversations.messages', 'session-1');
    expect(messagesRepository.findOne).toHaveBeenNthCalledWith(1, { filter: { messageId } });
    expect(messagesRepository.findOne).toHaveBeenNthCalledWith(2, {
      filter: { sessionId: 'session-1', role: 'user', messageId: { $lt: messageId } },
      sort: ['-messageId'],
    });
    expect(workContext[0]).toMatchObject({
      title: 'permitted-repository · aaaaaaa · Current commit title',
      content: { diff: '+current content' },
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('accepts a positive safe numeric messageId on resend', async () => {
    const targetMessage = {
      get: (field: string) =>
        field === 'messageId' ? 42 : field === 'role' ? 'user' : field === 'workContext' ? [] : null,
    };
    const messagesRepository = { findOne: vi.fn().mockResolvedValue(targetMessage) };
    const aiPlugin = {
      aiConversationsManager: { getConversation: vi.fn().mockResolvedValue({ sessionId: 'session-1' }) },
    };
    const { context, next } = createContext({
      app: createApp(aiPlugin),
      actionName: 'resendMessages',
      values: { sessionId: 'session-1', messageId: 42 },
      messagesRepository,
    });

    await enforceGitChatAdmission(context, next);

    expect(messagesRepository.findOne).toHaveBeenCalledWith({ filter: { messageId: 42 } });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('selects the latest session message only when messageId is absent', async () => {
    const targetMessage = {
      get: (field: string) =>
        field === 'messageId' ? '99' : field === 'role' ? 'user' : field === 'workContext' ? [] : null,
    };
    const messagesRepository = { findOne: vi.fn().mockResolvedValue(targetMessage) };
    const aiPlugin = {
      aiConversationsManager: { getConversation: vi.fn().mockResolvedValue({ sessionId: 'session-1' }) },
    };
    const { context, next } = createContext({
      app: createApp(aiPlugin),
      actionName: 'resendMessages',
      values: { sessionId: 'session-1' },
      messagesRepository,
    });

    await enforceGitChatAdmission(context, next);

    expect(messagesRepository.findOne).toHaveBeenCalledWith({
      filter: { sessionId: 'session-1' },
      sort: ['-messageId'],
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed messageId before reading the session or messages', async () => {
    const messagesRepository = { findOne: vi.fn() };
    const aiPlugin = { aiConversationsManager: { getConversation: vi.fn() } };
    const { context, next, getRepository, throwError } = createContext({
      app: createApp(aiPlugin),
      actionName: 'resendMessages',
      values: { sessionId: 'session-1', messageId: '9007199254740993x' },
      messagesRepository,
    });

    await expect(enforceGitChatAdmission(context, next)).rejects.toMatchObject({
      status: 400,
      message: 'Invalid messageId',
    });

    expect(throwError).toHaveBeenCalledWith(400, 'Invalid messageId');
    expect(aiPlugin.aiConversationsManager.getConversation).not.toHaveBeenCalled();
    expect(getRepository).not.toHaveBeenCalled();
    expect(messagesRepository.findOne).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('does not query message storage when the current user does not own the resend session', async () => {
    const messagesRepository = { findOne: vi.fn() };
    const aiPlugin = {
      aiConversationsManager: { getConversation: vi.fn().mockResolvedValue(null) },
    };
    const { context, next, getRepository } = createContext({
      app: createApp(aiPlugin),
      actionName: 'resendMessages',
      values: { sessionId: 'another-users-session', messageId: '2' },
      messagesRepository,
    });

    await enforceGitChatAdmission(context, next);

    expect(aiPlugin.aiConversationsManager.getConversation).toHaveBeenCalledWith({
      sessionId: 'another-users-session',
      userId: 21,
    });
    expect(getRepository).not.toHaveBeenCalled();
    expect(messagesRepository.findOne).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('redacts unavailable historical Git context without blocking unrelated messages', async () => {
    const strategies = new Map<string, { resolve: (ctx: Context, item: GitContext) => Promise<string> }>();
    const aiPlugin = {
      workContextHandler: {
        registerStrategy: vi.fn(
          (type: string, strategy: { resolve: (ctx: Context, item: GitContext) => Promise<string> }) => {
            strategies.set(type, strategy);
          },
        ),
      },
    };
    const app = createApp(aiPlugin);
    expect(registerGitChatContextStrategies(app)).toBe(true);
    mocks.loadChatContext.mockRejectedValue(new Error('Permission denied'));
    const { context, next } = createContext({ app, actionName: 'sendMessages', values: { messages: [] } });

    const strategy = strategies.get('git-commit');
    if (!strategy) throw new Error('Git commit context strategy was not registered');
    const response = await strategy.resolve(context, contextItem());

    expect(JSON.parse(response)).toEqual({ type: 'git-commit', content: { unavailable: true } });
    await enforceGitChatAdmission(context, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(registerGitChatContextStrategies(createApp())).toBe(false);
  });
});
