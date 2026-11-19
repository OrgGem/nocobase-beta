// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as ClientV2 from '@nocobase/client-v2';
import { FlowEngineProvider, observer, useFlowEngineContext, type FlowModel } from '@nocobase/flow-engine';
import {
  ChatBoxRuntimeProvider,
  getGlobalChatBoxRuntime,
  type ChatBoxRuntime,
  type Message,
} from '@nocobase/plugin-ai/client-v2';
import type { ToolCall } from '@nocobase/client-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatBoxRuntime } from '../../../../../@nocobase/plugin-ai/src/client-v2/ai-employees/chatbox/stores/runtime';
import { useToolCallActions } from '../../../../../@nocobase/plugin-ai/src/client-v2/ai-employees/chatbox/hooks/useToolCallActions';
import { AutoApprovalProvider } from '../AutoApprovalProvider';
import {
  AutoApprovalBridge,
  AutoApprovalRequests,
  AutoApprovalRequestsContext,
  useAutoApprovalInterceptor,
} from '../AutoApprovalBridge';
import V1PluginAgentOrchestratorClient from '../../../client/plugin';
import V2PluginAgentOrchestratorClient from '../../plugin';

const { resumeToolCallMock } = vi.hoisted(() => ({ resumeToolCallMock: vi.fn() }));

vi.mock('../../../../../@nocobase/plugin-ai/src/client-v2/ai-employees/chatbox/hooks/useChatMessageActions', () => ({
  useChatMessageActions: () => ({ resumeToolCall: resumeToolCallMock }),
}));

type RequestBody = Record<string, unknown>;
const emptyToolCalls: ToolCall[] = [];

function readRequestBody(data: unknown): RequestBody {
  const value: unknown = typeof data === 'string' ? JSON.parse(data) : data;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as RequestBody;
}

function makeToolbar(className: string, includeSearch = true) {
  const toolbar = document.createElement('div');
  toolbar.className = className;
  if (includeSearch) {
    const search = document.createElement('button');
    const icon = document.createElement('span');
    icon.className = 'anticon-global';
    search.append(icon);
    toolbar.append(search);
  }
  const submit = document.createElement('button');
  submit.className = 'ai-chat-sender-submit';
  toolbar.append(submit);
  return toolbar;
}

function attachRoot(runtime: ChatBoxRuntime, root: HTMLElement) {
  runtime.chatBoxModel.setChatBoxRef({ current: root });
}

function resetRuntime(runtime: ChatBoxRuntime) {
  runtime.chatBoxModel.setChatBoxRef({ current: null });
  runtime.chatBoxModel.setCurrentEmployee(null);
  runtime.chatBoxModel.setReadonly(false);
  runtime.chatConversationModel.setCurrentConversation(undefined);
  runtime.chatMessageModel.resetSessionState();
  runtime.chatToolCallModel.resetSessionState('__draft__');
}

function setRuntimeCalls(
  runtime: ChatBoxRuntime,
  sessionId: string,
  messageId: string,
  calls: ToolCall[],
  from?: 'sub-agent',
) {
  runtime.chatConversationModel.setCurrentConversation(sessionId);
  runtime.chatBoxModel.setCurrentEmployee({ username: 'native-agent' });
  runtime.chatMessageModel.setSessionMessages(sessionId, [
    {
      role: 'assistant',
      content: {
        content: '',
        messageId,
        metadata: { interruptId: `interrupt-${sessionId}` },
        ...(from ? { from } : {}),
        tool_calls: calls.map((call) => ({ ...call })),
      },
    } as Message,
  ]);
  for (const call of calls) {
    if (call.invokeStatus === 'interrupted' || call.invokeStatus === 'waiting') {
      runtime.chatToolCallModel.updateToolCallInvokeStatus(sessionId, messageId, call.id, call.invokeStatus);
    }
  }
}

function hydrateRuntimeCalls(runtime: ChatBoxRuntime, sessionId: string, messageId: string, calls: ToolCall[]) {
  runtime.chatMessageModel.setSessionMessages(sessionId, (entries) =>
    entries.map((entry) =>
      String(entry.content?.messageId) === messageId
        ? { ...entry, content: { ...entry.content, tool_calls: calls.map((call) => ({ ...call })) } }
        : entry,
    ),
  );
  for (const call of calls) {
    if (call.invokeStatus === 'interrupted' || call.invokeStatus === 'waiting') {
      runtime.chatToolCallModel.updateToolCallInvokeStatus(sessionId, messageId, call.id, call.invokeStatus);
    }
  }
}

function InterceptorScope({ requests, children }: { requests: AutoApprovalRequests; children: React.ReactNode }) {
  useAutoApprovalInterceptor(requests);
  return <AutoApprovalRequestsContext.Provider value={requests}>{children}</AutoApprovalRequestsContext.Provider>;
}

function DecisionControls({
  runtime,
  sessionId,
  messageId,
  actions,
}: {
  runtime: ChatBoxRuntime;
  sessionId: string;
  messageId: string;
  actions: Array<{ toolCallId: string; testId: string; label: string; onComplete?: () => void }>;
}) {
  const { getDecisionActions } = useToolCallActions({ messageId, runtime });
  const calls = runtime.chatMessageModel.sessions[sessionId]?.messages.find(
    (entry) => String(entry.content?.messageId) === messageId,
  )?.content.tool_calls;
  const approve = async (call: ToolCall, onComplete?: () => void) => {
    await getDecisionActions(call).approve();
    onComplete?.();
  };
  return (
    <>
      {actions.map(({ toolCallId, testId, label, onComplete }) => {
        const call = calls?.find((item) => item.id === toolCallId);
        return (
          <button key={testId} type="button" data-testid={testId} onClick={() => call && approve(call, onComplete)}>
            {label}
          </button>
        );
      })}
    </>
  );
}

function renderProvider(app: ReturnType<typeof ClientV2.createMockClient>, children?: React.ReactNode) {
  return render(
    <FlowEngineProvider engine={app.flowEngine}>
      <AutoApprovalProvider>{children}</AutoApprovalProvider>
    </FlowEngineProvider>,
  );
}

function makeDecisionBody(sessionId: string, messageId: string, call: ToolCall) {
  return {
    values: {
      sessionId,
      messageId,
      toolCallId: call.id,
      userDecision: { type: 'approve' },
    },
  };
}

let app: ReturnType<typeof ClientV2.createMockClient>;
let globalRuntime: ChatBoxRuntime;
const additionalApps: ReturnType<typeof ClientV2.createMockClient>[] = [];
const additionalRuntimes: ChatBoxRuntime[] = [];

beforeEach(() => {
  app = ClientV2.createMockClient();
  globalRuntime = getGlobalChatBoxRuntime();
  resetRuntime(globalRuntime);
  vi.spyOn(ClientV2, 'useApp').mockReturnValue(app);
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({
    matches: false,
    media,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  app.flowEngine.context.defineProperty('aiConfigRepository', {
    value: {
      aiTools: [],
      aiToolsLoading: false,
      getAITools: vi.fn().mockResolvedValue([]),
    },
  });
});

afterEach(() => {
  cleanup();
  resetRuntime(globalRuntime);
  for (const runtime of additionalRuntimes) resetRuntime(runtime);
  app.apiMock.restore();
  for (const additionalApp of additionalApps) additionalApp.apiMock.restore();
  additionalApps.length = 0;
  additionalRuntimes.length = 0;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('session automatic approval UI and native approval bridge', () => {
  it('registers the provider from both client plugin entries', async () => {
    const use = vi.spyOn(app, 'use');
    await new V2PluginAgentOrchestratorClient({}, app).load();
    expect(use).toHaveBeenCalledWith(AutoApprovalProvider);

    const legacyUse = vi.fn();
    const legacyApp = {
      use: legacyUse,
      pluginSettingsManager: { add: vi.fn() },
      eventBus: { addEventListener: vi.fn() },
      aiManager: { toolsManager: { registerTools: vi.fn() } },
      apiClient: { auth: { getToken: () => '' } },
    } as unknown as ConstructorParameters<typeof V1PluginAgentOrchestratorClient>[1];
    const legacyPlugin = Object.assign(Object.create(V1PluginAgentOrchestratorClient.prototype), {
      app: legacyApp,
      t: (value: string) => value,
    }) as V1PluginAgentOrchestratorClient;
    await legacyPlugin.load();
    expect(legacyUse).toHaveBeenCalledWith(AutoApprovalProvider);
  });

  it('portals independent global and block controls into normal and compact native toolbars', async () => {
    const blockRuntime = createChatBoxRuntime({ mode: 'block' });
    resetRuntime(blockRuntime);
    globalRuntime.chatConversationModel.setCurrentConversation('session-global');
    blockRuntime.chatConversationModel.setCurrentConversation('session-block');
    globalRuntime.chatBoxModel.setCurrentEmployee({ username: 'global-agent' });
    blockRuntime.chatBoxModel.setCurrentEmployee({ username: 'block-agent' });

    const globalRoot = document.createElement('div');
    const globalToolbar = makeToolbar('ai-chat-sender-tools');
    const blockRoot = document.createElement('div');
    const blockToolbar = makeToolbar('ai-chat-sender-compact-toolbar', false);
    globalRoot.append(globalToolbar, blockRoot);
    blockRoot.append(blockToolbar);
    document.body.append(globalRoot);
    attachRoot(globalRuntime, globalRoot);
    attachRoot(blockRuntime, blockRoot);

    vi.spyOn(app.flowEngine, 'forEachModel').mockImplementation((visit) => {
      visit({ chatBoxRuntime: blockRuntime } as unknown as FlowModel);
    });

    app.apiMock.onPost(/agentAutoApproval:get/).reply((config) => {
      const { sessionId } = readRequestBody(config.data);
      return [200, { data: { enabled: sessionId === 'session-global' || sessionId === 'session-next' } }];
    });
    const setRequests: RequestBody[] = [];
    app.apiMock.onPost(/agentAutoApproval:set/).reply((config) => {
      const body = readRequestBody(config.data);
      setRequests.push(body);
      return [200, { data: { enabled: body.enabled === true } }];
    });

    renderProvider(app);

    await within(globalToolbar).findByRole('button', { name: 'Disable automatic approval' });
    await within(blockToolbar).findByRole('button', { name: 'Enable automatic approval' });
    expect(
      within(globalToolbar).getByRole('button', { name: 'Disable automatic approval' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      within(blockToolbar).getByRole('button', { name: 'Enable automatic approval' }).getAttribute('aria-pressed'),
    ).toBe('false');
    expect(globalToolbar.children[1]?.getAttribute('data-agent-auto-approval')).toBe('true');
    expect(blockToolbar.children[0]?.getAttribute('data-agent-auto-approval')).toBe('true');

    const user = userEvent.setup();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(
      within(globalToolbar).getByRole('button', { name: 'Disable automatic approval' }),
    );
    act(() => fireEvent.click(within(globalToolbar).getByRole('button', { name: 'Disable automatic approval' })));
    await waitFor(() =>
      expect(
        within(globalToolbar).getByRole('button', { name: 'Enable automatic approval' }).getAttribute('aria-pressed'),
      ).toBe('false'),
    );
    expect(setRequests).toContainEqual({ sessionId: 'session-global', enabled: false });

    act(() => blockRuntime.chatConversationModel.setCurrentConversation('session-next'));
    await within(blockToolbar).findByRole('button', {
      name: 'Disable automatic approval',
    });
    expect(
      within(blockToolbar).getByRole('button', { name: 'Disable automatic approval' }).getAttribute('aria-pressed'),
    ).toBe('true');
    await waitFor(() => {
      expect(
        app.apiMock.history.post.some((request) => readRequestBody(request.data).sessionId === 'session-next'),
      ).toBe(true);
    });
  });

  it('creates a conversation from the draft before persisting automatic approval', async () => {
    globalRuntime.chatBoxModel.setCurrentEmployee({ username: 'draft-agent' });
    globalRuntime.chatMessageModel.setSessionSystemMessage(undefined, 'Draft system prompt');
    globalRuntime.chatMessageModel.setSessionSkillSettings(undefined, { tools: ['read_file'], skills: [] });
    globalRuntime.chatBoxModel.setModel({ llmService: 'openai', model: 'gpt-fast' });
    const root = document.createElement('div');
    const toolbar = makeToolbar('ai-chat-sender-compact-toolbar', false);
    root.append(toolbar);
    document.body.append(root);
    attachRoot(globalRuntime, root);

    let createdValues: RequestBody | undefined;
    app.apiMock.onPost(/aiConversations:create/).reply((config) => {
      const body = readRequestBody(config.data);
      const values = body.values;
      createdValues = values && typeof values === 'object' && !Array.isArray(values) ? (values as RequestBody) : body;
      return [200, { data: { sessionId: 'draft-session-created' } }];
    });
    let automaticApprovalEnabled = false;
    app.apiMock.onPost(/agentAutoApproval:get/).reply(() => [200, { data: { enabled: automaticApprovalEnabled } }]);
    const setRequests: RequestBody[] = [];
    app.apiMock.onPost(/agentAutoApproval:set/).reply((config) => {
      const body = readRequestBody(config.data);
      setRequests.push(body);
      automaticApprovalEnabled = body.enabled === true;
      return [200, { data: { enabled: automaticApprovalEnabled } }];
    });

    renderProvider(app);
    await within(toolbar).findByRole('button', { name: 'Enable automatic approval' });
    act(() => fireEvent.click(within(toolbar).getByRole('button', { name: 'Enable automatic approval' })));

    await waitFor(() => expect(globalRuntime.chatConversationModel.currentConversation).toBe('draft-session-created'));
    expect(createdValues).toMatchObject({
      aiEmployee: { username: 'draft-agent' },
      systemMessage: 'Draft system prompt',
      skillSettings: { tools: ['read_file'], skills: [] },
      modelSettings: { llmService: 'openai', model: 'gpt-fast' },
    });
    expect(setRequests).toContainEqual({ sessionId: 'draft-session-created', enabled: true });
    expect(globalRuntime.chatMessageModel.sessions['draft-session-created']?.systemMessage).toBe('Draft system prompt');
    await waitFor(
      () =>
        expect(
          within(toolbar).getByRole('button', { name: 'Disable automatic approval' }).getAttribute('aria-pressed'),
        ).toBe('true'),
      { timeout: 2000 },
    );
  });

  it('refreshes same-session runtimes together while keeping another session isolated and refreshing on focus', async () => {
    const sameSessionRuntime = createChatBoxRuntime({ mode: 'block' });
    const otherSessionRuntime = createChatBoxRuntime({ mode: 'block' });
    resetRuntime(sameSessionRuntime);
    resetRuntime(otherSessionRuntime);
    globalRuntime.chatConversationModel.setCurrentConversation('shared-session');
    sameSessionRuntime.chatConversationModel.setCurrentConversation('shared-session');
    otherSessionRuntime.chatConversationModel.setCurrentConversation('other-session');
    for (const runtime of [globalRuntime, sameSessionRuntime, otherSessionRuntime]) {
      runtime.chatBoxModel.setCurrentEmployee({ username: 'test-agent' });
    }

    const sharedRoot = document.createElement('div');
    const sameSessionRoot = document.createElement('div');
    const otherSessionRoot = document.createElement('div');
    const globalToolbar = makeToolbar('ai-chat-sender-tools');
    const sameSessionToolbar = makeToolbar('ai-chat-sender-compact-toolbar', false);
    const otherSessionToolbar = makeToolbar('ai-chat-sender-tools');
    sharedRoot.append(globalToolbar);
    sameSessionRoot.append(sameSessionToolbar);
    otherSessionRoot.append(otherSessionToolbar);
    document.body.append(sharedRoot, sameSessionRoot, otherSessionRoot);
    attachRoot(globalRuntime, sharedRoot);
    attachRoot(sameSessionRuntime, sameSessionRoot);
    attachRoot(otherSessionRuntime, otherSessionRoot);

    vi.spyOn(app.flowEngine, 'forEachModel').mockImplementation((visit) => {
      visit({ chatBoxRuntime: sameSessionRuntime } as unknown as FlowModel);
      visit({ chatBoxRuntime: otherSessionRuntime } as unknown as FlowModel);
    });

    const persisted = new Map([
      ['shared-session', false],
      ['other-session', false],
    ]);
    const reads = new Map<string, number>();
    app.apiMock.onPost(/agentAutoApproval:get/).reply((config) => {
      const { sessionId } = readRequestBody(config.data);
      if (typeof sessionId !== 'string') return [400, {}];
      reads.set(sessionId, (reads.get(sessionId) ?? 0) + 1);
      return [200, { data: { enabled: persisted.get(sessionId) === true } }];
    });
    app.apiMock.onPost(/agentAutoApproval:set/).reply((config) => {
      const body = readRequestBody(config.data);
      const sessionId = body.sessionId;
      if (typeof sessionId !== 'string') return [400, {}];
      persisted.set(sessionId, body.enabled === true);
      return [200, { data: { enabled: persisted.get(sessionId) === true } }];
    });

    renderProvider(app);
    await within(globalToolbar).findByRole('button', { name: 'Enable automatic approval' });
    await within(sameSessionToolbar).findByRole('button', {
      name: 'Enable automatic approval',
    });
    await within(otherSessionToolbar).findByRole('button', {
      name: 'Enable automatic approval',
    });
    const initialOtherReads = reads.get('other-session');

    await userEvent.setup().click(within(globalToolbar).getByRole('button', { name: 'Enable automatic approval' }));
    await waitFor(() =>
      expect(
        within(globalToolbar).getByRole('button', { name: 'Disable automatic approval' }).getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    await waitFor(() =>
      expect(
        within(sameSessionToolbar)
          .getByRole('button', { name: 'Disable automatic approval' })
          .getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    expect(
      within(otherSessionToolbar)
        .getByRole('button', { name: 'Enable automatic approval' })
        .getAttribute('aria-pressed'),
    ).toBe('false');
    expect(reads.get('other-session')).toBe(initialOtherReads);

    persisted.set('other-session', true);
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() =>
      expect(
        within(otherSessionToolbar)
          .getByRole('button', { name: 'Disable automatic approval' })
          .getAttribute('aria-pressed'),
      ).toBe('true'),
    );
  });

  it('runs the native sequential approval effect through the real bridge request identity', async () => {
    const sessionId = 'session-native-approval';
    const messageId = 'message-native-approval';
    const toolCallId = 'tool-call-native-approval';
    globalRuntime.chatConversationModel.setCurrentConversation(sessionId);
    globalRuntime.chatBoxModel.setCurrentEmployee({ username: 'native-agent' });
    const call: ToolCall = {
      id: toolCallId,
      type: 'function',
      name: 'read_file',
      args: { path: 'notes.md' },
      invokeStatus: 'interrupted',
      auto: false,
    };
    const message: Message = {
      role: 'assistant',
      content: { content: '', messageId, tool_calls: [call] },
    };
    globalRuntime.chatMessageModel.setSessionMessages(sessionId, [message]);
    globalRuntime.chatToolCallModel.updateToolCallInvokeStatus(sessionId, messageId, toolCallId, 'interrupted');

    const root = document.createElement('div');
    const toolbar = makeToolbar('ai-chat-sender-tools');
    root.append(toolbar);
    document.body.append(root);
    attachRoot(globalRuntime, root);

    app.apiMock.onPost(/agentAutoApproval:get/).reply(200, { data: { enabled: true } });
    app.apiMock.onPost(/agentAutoApproval:eligible/).reply(200, { data: { eligible: true } });
    let decisionRequest: RequestBody | undefined;
    app.apiMock.onPost(/aiConversations:updateUserDecision/).reply((config) => {
      decisionRequest = readRequestBody(config.data);
      return [200, { data: { updated: 0 } }];
    });

    const NativeToolCardHarness = observer(() => {
      const currentMessage = globalRuntime.chatMessageModel.sessions[sessionId]?.messages[0];
      const calls = currentMessage?.content.tool_calls ?? emptyToolCalls;
      React.useEffect(() => {
        const approveAutomatically = async () => {
          for (const toolCall of calls) {
            if (toolCall.invokeStatus === 'interrupted' && toolCall.auto === true) {
              await app.apiClient
                .resource('aiConversations')
                .updateUserDecision(makeDecisionBody(sessionId, messageId, toolCall));
            }
          }
        };
        approveAutomatically();
      }, [calls]);
      return null;
    });

    renderProvider(
      app,
      <ChatBoxRuntimeProvider runtime={globalRuntime}>
        <NativeToolCardHarness />
      </ChatBoxRuntimeProvider>,
    );

    await waitFor(() =>
      expect(decisionRequest).toMatchObject({
        sessionId,
        messageId,
        toolCallId,
        userDecision: { type: 'approve' },
        agentAutoApproval: true,
      }),
    );
    await waitFor(() => {
      expect(globalRuntime.chatMessageModel.sessions[sessionId]?.messages[0]?.content.tool_calls?.[0]?.auto).toBe(
        false,
      );
    });
  });

  it('approves the next queued ASK after the native model replaces toolCalls and resumes once all are waiting', async () => {
    const sessionId = 'session-native-sibling-asks';
    const messageId = 'message-native-sibling-asks';
    globalRuntime.chatConversationModel.setCurrentConversation(sessionId);
    globalRuntime.chatBoxModel.setCurrentEmployee({ username: 'native-agent' });
    const calls: ToolCall[] = [
      {
        id: 'call-a',
        type: 'function',
        name: 'read_file',
        args: { path: 'a.md' },
        invokeStatus: 'interrupted',
        auto: false,
      },
      {
        id: 'call-b',
        type: 'function',
        name: 'search_files',
        args: { query: 'B' },
        invokeStatus: 'interrupted',
        auto: false,
      },
    ];
    globalRuntime.chatMessageModel.setSessionMessages(sessionId, [
      { role: 'assistant', content: { content: '', messageId, tool_calls: calls } },
    ]);
    for (const call of calls) {
      globalRuntime.chatToolCallModel.updateToolCallInvokeStatus(sessionId, messageId, call.id, 'interrupted');
    }
    const modelSession = globalRuntime.chatToolCallModel.sessions[sessionId];
    const initialToolCallsMap = modelSession?.toolCalls;
    expect(modelSession).toBeDefined();

    const root = document.createElement('div');
    const toolbar = makeToolbar('ai-chat-sender-tools');
    root.append(toolbar);
    document.body.append(root);
    attachRoot(globalRuntime, root);

    app.apiMock.onPost(/agentAutoApproval:get/).reply(200, { data: { enabled: true } });
    app.apiMock.onPost(/agentAutoApproval:eligible/).reply(200, { data: { eligible: true } });
    const decisionRequests: RequestBody[] = [];
    app.apiMock.onPost(/aiConversations:updateUserDecision/).reply((config) => {
      decisionRequests.push(readRequestBody(config.data));
      return [
        200,
        {
          data: {
            updated: 1,
            toolCalls: calls.map((call) => ({ ...call, userDecision: { type: 'approve' } })),
          },
        },
      ];
    });
    resumeToolCallMock.mockClear();

    const NativeToolCardHarness = observer(() => {
      const currentMessage = globalRuntime.chatMessageModel.sessions[sessionId]?.messages[0];
      const toolCalls = currentMessage?.content.tool_calls ?? emptyToolCalls;
      const requested = React.useRef(new Set<string>());
      const { getDecisionActions } = useToolCallActions({ messageId, runtime: globalRuntime });

      React.useEffect(() => {
        const approveAutomatically = async () => {
          for (const toolCall of toolCalls) {
            if (
              toolCall.invokeStatus === 'interrupted' &&
              toolCall.auto === true &&
              !requested.current.has(toolCall.id)
            ) {
              requested.current.add(toolCall.id);
              await getDecisionActions(toolCall).approve();
            }
          }
        };
        approveAutomatically();
      }, [getDecisionActions, toolCalls]);

      return null;
    });

    renderProvider(
      app,
      <ChatBoxRuntimeProvider runtime={globalRuntime}>
        <NativeToolCardHarness />
      </ChatBoxRuntimeProvider>,
    );

    await waitFor(() => expect(decisionRequests).toHaveLength(2));
    expect(decisionRequests.map((request) => request.toolCallId)).toEqual(['call-a', 'call-b']);
    expect(decisionRequests.every((request) => request.agentAutoApproval === true)).toBe(true);
    await waitFor(() => expect(globalRuntime.chatToolCallModel.isAllWaiting(sessionId, messageId)).toBe(true));
    expect(globalRuntime.chatToolCallModel.sessions[sessionId]).toBe(modelSession);
    expect(modelSession?.toolCalls).not.toBe(initialToolCallsMap);
    expect(globalRuntime.chatToolCallModel.getInvokeStatus(sessionId, messageId, 'call-a')).toBe('waiting');
    expect(globalRuntime.chatToolCallModel.getInvokeStatus(sessionId, messageId, 'call-b')).toBe('waiting');
    expect(resumeToolCallMock).toHaveBeenCalledTimes(1);
    expect(resumeToolCallMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId, messageId, toolCallIds: ['call-a', 'call-b'], toolCallResults: [] }),
    );
  });

  it('does not approve the second queued ASK after auto-approval is disabled during the first request', async () => {
    const sessionId = 'session-two-asks';
    const messageId = 'message-two-asks';
    globalRuntime.chatConversationModel.setCurrentConversation(sessionId);
    globalRuntime.chatBoxModel.setCurrentEmployee({ username: 'native-agent' });
    const calls: ToolCall[] = [
      {
        id: 'call-a',
        type: 'function',
        name: 'read_file',
        args: { path: 'a.md' },
        invokeStatus: 'interrupted',
        auto: false,
      },
      {
        id: 'call-b',
        type: 'function',
        name: 'search_files',
        args: { query: 'B' },
        invokeStatus: 'interrupted',
        auto: false,
      },
    ];
    globalRuntime.chatMessageModel.setSessionMessages(sessionId, [
      { role: 'assistant', content: { content: '', messageId, tool_calls: calls } },
    ]);
    for (const call of calls) {
      globalRuntime.chatToolCallModel.updateToolCallInvokeStatus(sessionId, messageId, call.id, 'interrupted');
    }

    const root = document.createElement('div');
    const toolbar = makeToolbar('ai-chat-sender-tools');
    root.append(toolbar);
    document.body.append(root);
    attachRoot(globalRuntime, root);

    let enabled = true;
    app.apiMock.onPost(/agentAutoApproval:get/).reply(() => [200, { data: { enabled } }]);
    app.apiMock.onPost(/agentAutoApproval:set/).reply((config) => {
      enabled = readRequestBody(config.data).enabled === true;
      return [200, { data: { enabled } }];
    });
    app.apiMock.onPost(/agentAutoApproval:eligible/).reply(200, { data: { eligible: true } });

    const decisionRequests: RequestBody[] = [];
    let manualBUpdated = false;
    let releaseFirstRequest: (() => void) | undefined;
    app.apiMock.onPost(/aiConversations:updateUserDecision/).reply((config) => {
      const body = readRequestBody(config.data);
      decisionRequests.push(body);
      if (body.toolCallId === 'call-a' && body.agentAutoApproval === true && !releaseFirstRequest) {
        return new Promise((resolve) => {
          releaseFirstRequest = () => resolve([200, { data: { updated: 0 } }]);
        });
      }
      const staleAutomaticRequest = body.agentAutoApproval === true && !enabled;
      if (body.toolCallId === 'call-b' && body.agentAutoApproval !== true && !enabled) manualBUpdated = true;
      return [200, { data: { updated: staleAutomaticRequest ? 0 : 1 } }];
    });

    const NativeToolCardHarness = observer(() => {
      const currentMessage = globalRuntime.chatMessageModel.sessions[sessionId]?.messages[0];
      const toolCalls = currentMessage?.content.tool_calls ?? emptyToolCalls;
      const automaticRequests = React.useRef(new Set<string>());
      React.useEffect(() => {
        const approveAutomatically = async () => {
          for (const toolCall of toolCalls) {
            if (
              toolCall.invokeStatus === 'interrupted' &&
              toolCall.auto === true &&
              !automaticRequests.current.has(toolCall.id)
            ) {
              automaticRequests.current.add(toolCall.id);
              await app.apiClient
                .resource('aiConversations')
                .updateUserDecision(makeDecisionBody(sessionId, messageId, toolCall));
            }
          }
        };
        approveAutomatically();
      }, [toolCalls]);
      const approveManually = async () => {
        const callB = toolCalls.find((toolCall) => toolCall.id === 'call-b');
        if (callB?.invokeStatus === 'interrupted') {
          await app.apiClient
            .resource('aiConversations')
            .updateUserDecision(makeDecisionBody(sessionId, messageId, callB));
        }
      };
      return (
        <button type="button" onClick={approveManually}>
          Allow use
        </button>
      );
    });

    renderProvider(
      app,
      <ChatBoxRuntimeProvider runtime={globalRuntime}>
        <NativeToolCardHarness />
      </ChatBoxRuntimeProvider>,
    );

    await within(toolbar).findByRole('button', { name: 'Disable automatic approval' });
    await waitFor(() => {
      const marked = globalRuntime.chatMessageModel.sessions[sessionId]?.messages[0]?.content.tool_calls ?? [];
      expect(marked.find((call) => call.id === 'call-a')?.auto).toBe(true);
      expect(marked.find((call) => call.id === 'call-b')?.auto).toBe(false);
    });
    await waitFor(() => expect(releaseFirstRequest).toBeDefined());

    const user = userEvent.setup();
    await user.click(within(toolbar).getByRole('button', { name: 'Disable automatic approval' }));
    await waitFor(
      () =>
        expect(
          within(toolbar).getByRole('button', { name: 'Enable automatic approval' }).getAttribute('aria-pressed'),
        ).toBe('false'),
      { timeout: 2000 },
    );
    await waitFor(() => {
      const restored = globalRuntime.chatMessageModel.sessions[sessionId]?.messages[0]?.content.tool_calls ?? [];
      expect(restored.every((call) => call.auto === false)).toBe(true);
    });

    releaseFirstRequest?.();
    await waitFor(() => expect(decisionRequests.some((request) => request.toolCallId === 'call-a')).toBe(true));
    await act(async () => Promise.resolve());
    const automaticB = decisionRequests.filter((request) => request.toolCallId === 'call-b');
    expect(
      automaticB.every((request) => request.agentAutoApproval === true),
      'a second automatic request must be suppressed or retain its marker so the disabled server policy rejects it',
    ).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Allow use' }));
    await waitFor(() => {
      expect(
        decisionRequests.some((request) => request.toolCallId === 'call-b' && !('agentAutoApproval' in request)),
      ).toBe(true);
      expect(manualBUpdated).toBe(true);
    });
  });

  it('keeps the automatic origin authorized when the embedded runtime leaves before the winner response', async () => {
    const sessionId = 'session-shared-app-runtimes';
    const messageId = 'message-shared-app-runtimes';
    const interruptId = `interrupt-${sessionId}`;
    const calls: ToolCall[] = [
      {
        id: 'call-auto-origin',
        type: 'function',
        name: 'tool-a',
        args: { value: 'A' },
        invokeStatus: 'interrupted',
        auto: false,
        willInterrupt: true,
      },
      {
        id: 'call-manual-winner',
        type: 'function',
        name: 'tool-b',
        args: { value: 'B' },
        invokeStatus: 'interrupted',
        auto: false,
        willInterrupt: true,
      },
    ];
    const embeddedRuntime = createChatBoxRuntime({ mode: 'block' });
    additionalRuntimes.push(embeddedRuntime);
    setRuntimeCalls(globalRuntime, sessionId, messageId, calls);
    setRuntimeCalls(embeddedRuntime, sessionId, messageId, calls);
    const requests = new AutoApprovalRequests();
    const serverCalls = calls.map((call) => ({ ...call }));
    const decisionRequests: RequestBody[] = [];
    let enrolled = false;
    let issued = false;
    let releaseAutomaticPartial: (() => void) | undefined;
    let releaseManualWinner: (() => void) | undefined;
    let automaticPayload: RequestBody | undefined;
    const invokeA = vi.fn(async () => ({ status: 'success', content: 'A result' }));
    const invokeB = vi.fn(async () => ({ status: 'success', content: 'B result' }));

    app.aiManager.toolsManager.registerTools('tool-a', { invoke: invokeA });
    app.aiManager.toolsManager.registerTools('tool-b', { invoke: invokeB });
    app.apiMock.onPost(/agentAutoApproval:get/).reply(200, { data: { enabled: true } });
    app.apiMock.onPost(/agentAutoApproval:eligible/).reply((config) => {
      const request = readRequestBody(config.data);
      return [200, { data: { eligible: request.toolCallId === 'call-auto-origin' } }];
    });
    app.apiMock.onPost(/aiConversations:updateUserDecision/).reply((config) => {
      const request = readRequestBody(config.data);
      decisionRequests.push(request);
      const selected = serverCalls.find((call) => call.id === request.toolCallId);
      let nativeUpdated = 0;
      if (selected?.invokeStatus === 'interrupted') {
        selected.invokeStatus = 'waiting';
        selected.userDecision = request.userDecision;
        nativeUpdated = 1;
        if (request.agentAutoApproval === true) enrolled = true;
      }
      const ready =
        enrolled && serverCalls.filter((call) => call.willInterrupt).every((call) => call.invokeStatus === 'waiting');
      const canFinalize = nativeUpdated === 1 && ready && !issued;
      if (canFinalize) issued = true;
      const payload: RequestBody = {
        updated: enrolled ? (canFinalize ? 1 : 0) : nativeUpdated,
        toolCalls: serverCalls.map((call) => ({ ...call })),
        ...(enrolled
          ? {
              agentAutoApprovalCheckpoint: {
                interruptId,
                decisionRecorded: nativeUpdated === 1,
                canFinalize,
                validSnapshot: true,
              },
            }
          : {}),
      };
      if (request.toolCallId === 'call-auto-origin' && request.agentAutoApproval === true) {
        automaticPayload = payload;
        return new Promise((resolve) => {
          releaseAutomaticPartial = () => resolve([200, { data: payload }]);
        });
      }
      if (request.toolCallId === 'call-manual-winner') {
        return new Promise((resolve) => {
          releaseManualWinner = () => resolve([200, { data: payload }]);
        });
      }
      return [200, { data: payload }];
    });

    const AppHarness = () => {
      const [showEmbedded, setShowEmbedded] = React.useState(true);
      return (
        <InterceptorScope requests={requests}>
          <AutoApprovalBridge runtime={globalRuntime} enabled />
          {showEmbedded && <AutoApprovalBridge runtime={embeddedRuntime} enabled />}
          <button type="button" data-testid="unmount-embedded-runtime" onClick={() => setShowEmbedded(false)}>
            Leave embedded chat
          </button>
          <ChatBoxRuntimeProvider runtime={globalRuntime}>
            <DecisionControls
              runtime={globalRuntime}
              sessionId={sessionId}
              messageId={messageId}
              actions={[
                { toolCallId: 'call-auto-origin', testId: 'approve-origin-call', label: 'Approve A' },
                { toolCallId: 'call-manual-winner', testId: 'approve-winner-call', label: 'Approve B' },
              ]}
            />
          </ChatBoxRuntimeProvider>
        </InterceptorScope>
      );
    };

    resumeToolCallMock.mockClear();
    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <AppHarness />
      </FlowEngineProvider>,
    );

    const identity = { sessionId, messageId, toolCallId: 'call-auto-origin' };
    await waitFor(() => {
      expect(globalRuntime.chatMessageModel.sessions[sessionId]?.messages[0]?.content.tool_calls?.[0]?.auto).toBe(true);
      expect(requests.matchingRuntimes(identity)).toHaveLength(2);
    });
    await userEvent.click(screen.getByTestId('approve-origin-call'));
    await waitFor(() => expect(releaseAutomaticPartial).toBeDefined());
    await userEvent.click(screen.getByTestId('approve-winner-call'));
    await waitFor(() => expect(releaseManualWinner).toBeDefined());
    expect(decisionRequests).toHaveLength(2);
    expect(decisionRequests[0].agentAutoApproval).toBe(true);
    expect('agentAutoApproval' in decisionRequests[1]).toBe(false);
    expect(automaticPayload?.agentAutoApprovalCheckpoint).toMatchObject({ canFinalize: false, validSnapshot: true });

    await userEvent.click(screen.getByTestId('unmount-embedded-runtime'));
    await waitFor(() => expect(requests.matchingRuntimes(identity)).toEqual([globalRuntime]));
    await act(async () => {
      releaseManualWinner?.();
    });

    await waitFor(() => expect(resumeToolCallMock).toHaveBeenCalledTimes(1));
    expect(invokeA).toHaveBeenCalledTimes(1);
    expect(invokeB).toHaveBeenCalledTimes(1);
    expect(resumeToolCallMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId, messageId, toolCallIds: ['call-auto-origin', 'call-manual-winner'] }),
    );

    await act(async () => {
      releaseAutomaticPartial?.();
    });
    await waitFor(() => expect(automaticPayload?.updated).toBe(0));
    expect(globalRuntime.chatToolCallModel.isAllWaiting(sessionId, messageId)).toBe(true);
    expect(invokeA).toHaveBeenCalledTimes(1);
    expect(invokeB).toHaveBeenCalledTimes(1);
    expect(resumeToolCallMock).toHaveBeenCalledTimes(1);
  });

  it.each(['switches away', 'is replaced'] as const)(
    'does not run an automatic winner after its origin runtime %s even when an embedded runtime matches',
    async (originChange) => {
      const sessionId = `session-origin-${originChange.replace(/ /g, '-')}`;
      const messageId = `message-origin-${originChange.replace(/ /g, '-')}`;
      const interruptId = `interrupt-${sessionId}`;
      const calls: ToolCall[] = [
        {
          id: 'call-origin-auto',
          type: 'function',
          name: 'tool-a',
          args: { value: 'A' },
          invokeStatus: 'interrupted',
          auto: false,
          willInterrupt: true,
        },
        {
          id: 'call-already-waiting',
          type: 'function',
          name: 'tool-b',
          args: { value: 'B' },
          invokeStatus: 'waiting',
          auto: false,
          willInterrupt: true,
          userDecision: { type: 'approve' },
        },
      ];
      const embeddedRuntime = createChatBoxRuntime({ mode: 'block' });
      additionalRuntimes.push(embeddedRuntime);
      setRuntimeCalls(globalRuntime, sessionId, messageId, calls);
      setRuntimeCalls(embeddedRuntime, sessionId, messageId, calls);
      const requests = new AutoApprovalRequests();
      const serverCalls = calls.map((call) => ({ ...call }));
      let releaseWinner: (() => void) | undefined;
      let autoDecisionRequest: RequestBody | undefined;
      let originDecisionCompleted = false;
      const invokeA = vi.fn(async () => ({ status: 'success', content: 'A result' }));
      const invokeB = vi.fn(async () => ({ status: 'success', content: 'B result' }));
      app.aiManager.toolsManager.registerTools('tool-a', { invoke: invokeA });
      app.aiManager.toolsManager.registerTools('tool-b', { invoke: invokeB });
      app.apiMock.onPost(/agentAutoApproval:get/).reply(200, { data: { enabled: true } });
      app.apiMock.onPost(/agentAutoApproval:eligible/).reply((config) => {
        return [200, { data: { eligible: readRequestBody(config.data).toolCallId === 'call-origin-auto' } }];
      });
      app.apiMock.onPost(/aiConversations:updateUserDecision/).reply((config) => {
        const request = readRequestBody(config.data);
        autoDecisionRequest = request;
        const selected = serverCalls.find((call) => call.id === request.toolCallId);
        if (selected?.invokeStatus === 'interrupted') {
          selected.invokeStatus = 'waiting';
          selected.userDecision = request.userDecision;
        }
        const payload: RequestBody = {
          updated: 1,
          toolCalls: serverCalls.map((call) => ({ ...call })),
          agentAutoApprovalCheckpoint: {
            interruptId,
            decisionRecorded: true,
            canFinalize: true,
            validSnapshot: true,
          },
        };
        return new Promise((resolve) => {
          releaseWinner = () => resolve([200, { data: payload }]);
        });
      });

      const AppHarness = () => {
        const [showOriginBridge, setShowOriginBridge] = React.useState(true);
        return (
          <InterceptorScope requests={requests}>
            {showOriginBridge && <AutoApprovalBridge runtime={globalRuntime} enabled />}
            <AutoApprovalBridge runtime={embeddedRuntime} enabled />
            <button type="button" data-testid="replace-origin-bridge" onClick={() => setShowOriginBridge(false)}>
              Replace origin runtime
            </button>
            <button
              type="button"
              data-testid="switch-origin-session"
              onClick={() => globalRuntime.chatConversationModel.setCurrentConversation('another-session')}
            >
              Switch origin session
            </button>
            <ChatBoxRuntimeProvider runtime={globalRuntime}>
              <DecisionControls
                runtime={globalRuntime}
                sessionId={sessionId}
                messageId={messageId}
                actions={[
                  {
                    toolCallId: 'call-origin-auto',
                    testId: 'approve-auto-origin',
                    label: 'Approve A',
                    onComplete: () => {
                      originDecisionCompleted = true;
                    },
                  },
                ]}
              />
            </ChatBoxRuntimeProvider>
          </InterceptorScope>
        );
      };

      resumeToolCallMock.mockClear();
      render(
        <FlowEngineProvider engine={app.flowEngine}>
          <AppHarness />
        </FlowEngineProvider>,
      );

      const identity = { sessionId, messageId, toolCallId: 'call-origin-auto' };
      await waitFor(() => {
        expect(globalRuntime.chatMessageModel.sessions[sessionId]?.messages[0]?.content.tool_calls?.[0]?.auto).toBe(
          true,
        );
        expect(requests.matchingRuntimes(identity)).toHaveLength(2);
      });
      await userEvent.click(screen.getByTestId('approve-auto-origin'));
      await waitFor(() => expect(releaseWinner).toBeDefined());

      if (originChange === 'switches away') {
        await userEvent.click(screen.getByTestId('switch-origin-session'));
      } else {
        await userEvent.click(screen.getByTestId('replace-origin-bridge'));
      }
      await waitFor(() => expect(requests.matchingRuntimes(identity)).toEqual([embeddedRuntime]));
      await act(async () => {
        releaseWinner?.();
      });

      await waitFor(() => expect(originDecisionCompleted).toBe(true));
      await waitFor(() => expect(embeddedRuntime.chatToolCallModel.isAllWaiting(sessionId, messageId)).toBe(true));
      expect(autoDecisionRequest?.agentAutoApproval).toBe(true);
      expect(invokeA).not.toHaveBeenCalled();
      expect(invokeB).not.toHaveBeenCalled();
      expect(resumeToolCallMock).not.toHaveBeenCalled();
    },
  );

  it('advances a tracked unmanaged partial and lets a manual sibling decision finish the turn', async () => {
    const sessionId = 'session-unmanaged-partial';
    const messageId = 'message-unmanaged-partial';
    const calls: ToolCall[] = [
      {
        id: 'call-partial-a',
        type: 'function',
        name: 'tool-a',
        args: { value: 'A' },
        invokeStatus: 'interrupted',
        auto: false,
        willInterrupt: true,
      },
      {
        id: 'call-manual-b',
        type: 'function',
        name: 'tool-b',
        args: { value: 'B' },
        invokeStatus: 'interrupted',
        auto: false,
        willInterrupt: true,
      },
    ];
    setRuntimeCalls(globalRuntime, sessionId, messageId, calls);
    const requests = new AutoApprovalRequests();
    const serverCalls = calls.map((call) => ({ ...call }));
    const decisionRequests: RequestBody[] = [];
    const invokeA = vi.fn(async () => ({ status: 'success', content: 'A result' }));
    const invokeB = vi.fn(async () => ({ status: 'success', content: 'B result' }));
    app.aiManager.toolsManager.registerTools('tool-a', { invoke: invokeA });
    app.aiManager.toolsManager.registerTools('tool-b', { invoke: invokeB });
    app.apiMock.onPost(/aiConversations:updateUserDecision/).reply((config) => {
      const request = readRequestBody(config.data);
      decisionRequests.push(request);
      const selected = serverCalls.find((call) => call.id === request.toolCallId);
      if (selected?.invokeStatus === 'interrupted') {
        selected.invokeStatus = 'waiting';
        selected.userDecision = request.userDecision;
      }
      return [
        200,
        {
          data: {
            updated: 1,
            toolCalls: serverCalls.map((call) => ({ ...call })),
          },
        },
      ];
    });

    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <InterceptorScope requests={requests}>
          <AutoApprovalBridge runtime={globalRuntime} enabled={false} />
          <ChatBoxRuntimeProvider runtime={globalRuntime}>
            <DecisionControls
              runtime={globalRuntime}
              sessionId={sessionId}
              messageId={messageId}
              actions={[
                { toolCallId: 'call-partial-a', testId: 'manual-partial-a', label: 'Approve A' },
                { toolCallId: 'call-manual-b', testId: 'manual-partial-b', label: 'Approve B' },
              ]}
            />
          </ChatBoxRuntimeProvider>
        </InterceptorScope>
      </FlowEngineProvider>,
    );

    const identity = { sessionId, messageId, toolCallId: 'call-partial-a' };
    await waitFor(() => expect(requests.matchingRuntimes(identity)).toEqual([globalRuntime]));
    await userEvent.click(screen.getByTestId('manual-partial-a'));
    await waitFor(() => {
      expect(globalRuntime.chatToolCallModel.getInvokeStatus(sessionId, messageId, 'call-partial-a')).toBe('waiting');
      expect(globalRuntime.chatToolCallModel.getInvokeStatus(sessionId, messageId, 'call-manual-b')).toBe(
        'interrupted',
      );
    });
    expect(decisionRequests).toHaveLength(1);
    expect('agentAutoApproval' in decisionRequests[0]).toBe(false);
    expect(invokeA).not.toHaveBeenCalled();
    expect(invokeB).not.toHaveBeenCalled();
    expect(resumeToolCallMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('manual-partial-b'));
    await waitFor(() => expect(resumeToolCallMock).toHaveBeenCalledTimes(1));
    expect(decisionRequests).toHaveLength(2);
    expect(decisionRequests.every((request) => !('agentAutoApproval' in request))).toBe(true);
    expect(globalRuntime.chatToolCallModel.isAllWaiting(sessionId, messageId)).toBe(true);
    expect(invokeA).toHaveBeenCalledTimes(1);
    expect(invokeB).toHaveBeenCalledTimes(1);
  });

  it('preserves an unmanaged manual sub-agent partial response when no root runtime is registered', async () => {
    const sessionId = 'session-untracked-sub-agent';
    const messageId = 'message-untracked-sub-agent';
    const subAgentRuntime = createChatBoxRuntime({ mode: 'block' });
    additionalRuntimes.push(subAgentRuntime);
    const calls: ToolCall[] = [
      {
        id: 'call-sub-agent-a',
        type: 'function',
        name: 'tool-a',
        args: { value: 'A' },
        invokeStatus: 'interrupted',
        auto: false,
        willInterrupt: true,
      },
      {
        id: 'call-sub-agent-b',
        type: 'function',
        name: 'tool-b',
        args: { value: 'B' },
        invokeStatus: 'interrupted',
        auto: false,
        willInterrupt: true,
      },
    ];
    setRuntimeCalls(subAgentRuntime, sessionId, messageId, calls, 'sub-agent');
    const requests = new AutoApprovalRequests();
    const decisionRequests: RequestBody[] = [];
    app.apiMock.onPost(/aiConversations:updateUserDecision/).reply((config) => {
      decisionRequests.push(readRequestBody(config.data));
      return [
        200,
        {
          data: {
            updated: 1,
            toolCalls: [
              { ...calls[0], invokeStatus: 'waiting', userDecision: { type: 'approve' } },
              { ...calls[1], invokeStatus: 'interrupted' },
            ],
          },
        },
      ];
    });

    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <InterceptorScope requests={requests}>
          <ChatBoxRuntimeProvider runtime={subAgentRuntime}>
            <DecisionControls
              runtime={subAgentRuntime}
              sessionId={sessionId}
              messageId={messageId}
              actions={[{ toolCallId: 'call-sub-agent-a', testId: 'approve-sub-agent-a', label: 'Approve A' }]}
            />
          </ChatBoxRuntimeProvider>
        </InterceptorScope>
      </FlowEngineProvider>,
    );

    const identity = { sessionId, messageId, toolCallId: 'call-sub-agent-a' };
    expect(requests.matchingRuntimes(identity)).toHaveLength(0);
    await userEvent.click(screen.getByTestId('approve-sub-agent-a'));
    await waitFor(() => {
      expect(subAgentRuntime.chatToolCallModel.getInvokeStatus(sessionId, messageId, 'call-sub-agent-a')).toBe(
        'waiting',
      );
      expect(subAgentRuntime.chatToolCallModel.getInvokeStatus(sessionId, messageId, 'call-sub-agent-b')).toBe(
        'interrupted',
      );
    });
    expect(decisionRequests).toHaveLength(1);
    expect('agentAutoApproval' in decisionRequests[0]).toBe(false);
    expect(requests.matchingRuntimes(identity)).toHaveLength(0);
    expect(resumeToolCallMock).not.toHaveBeenCalled();
  });

  it('suppresses a pre-enrollment partial after another tab wins and the sender runtime hydrates all calls', async () => {
    const appTwo = ClientV2.createMockClient();
    additionalApps.push(appTwo);
    const sessionId = 'session-pre-enrollment-partial';
    const messageId = 'message-pre-enrollment-partial';
    const interruptId = `interrupt-${sessionId}`;
    const calls: ToolCall[] = [
      {
        id: 'call-stale-a',
        type: 'function',
        name: 'tool-a',
        args: { value: 'A' },
        invokeStatus: 'interrupted',
        auto: false,
        willInterrupt: true,
      },
      {
        id: 'call-auto-b',
        type: 'function',
        name: 'tool-b',
        args: { value: 'B' },
        invokeStatus: 'interrupted',
        auto: false,
        willInterrupt: true,
      },
    ];
    const winnerRuntime = createChatBoxRuntime({ mode: 'block' });
    additionalRuntimes.push(winnerRuntime);
    setRuntimeCalls(globalRuntime, sessionId, messageId, calls);
    const senderRequests = new AutoApprovalRequests();
    const winnerRequests = new AutoApprovalRequests();
    const serverCalls = calls.map((call) => ({ ...call }));
    const senderDecisionRequests: RequestBody[] = [];
    const winnerDecisionRequests: RequestBody[] = [];
    let releaseStalePartial: (() => void) | undefined;
    let stalePayload: RequestBody | undefined;
    let staleActionCompleted = false;
    let checkpointEnrolled = false;
    let checkpointIssued = false;
    const senderInvokeA = vi.fn(async () => ({ status: 'success', content: 'sender A' }));
    const senderInvokeB = vi.fn(async () => ({ status: 'success', content: 'sender B' }));
    const winnerInvokeA = vi.fn(async () => ({ status: 'success', content: 'winner A' }));
    const winnerInvokeB = vi.fn(async () => ({ status: 'success', content: 'winner B' }));
    app.aiManager.toolsManager.registerTools('tool-a', { invoke: senderInvokeA });
    app.aiManager.toolsManager.registerTools('tool-b', { invoke: senderInvokeB });
    appTwo.aiManager.toolsManager.registerTools('tool-a', { invoke: winnerInvokeA });
    appTwo.aiManager.toolsManager.registerTools('tool-b', { invoke: winnerInvokeB });

    app.apiMock.onPost(/aiConversations:updateUserDecision/).reply((config) => {
      const request = readRequestBody(config.data);
      senderDecisionRequests.push(request);
      const selected = serverCalls.find((call) => call.id === request.toolCallId);
      let nativeUpdated = 0;
      if (selected?.invokeStatus === 'interrupted') {
        selected.invokeStatus = 'waiting';
        selected.userDecision = request.userDecision;
        nativeUpdated = 1;
      }
      const payload: RequestBody = {
        updated: nativeUpdated,
        toolCalls: serverCalls.map((call) => ({ ...call })),
      };
      if (request.toolCallId === 'call-stale-a') {
        stalePayload = payload;
        return new Promise((resolve) => {
          releaseStalePartial = () => resolve([200, { data: payload }]);
        });
      }
      return [200, { data: payload }];
    });
    appTwo.apiMock.onPost(/agentAutoApproval:get/).reply(200, { data: { enabled: true } });
    appTwo.apiMock.onPost(/agentAutoApproval:eligible/).reply((config) => {
      const request = readRequestBody(config.data);
      return [200, { data: { eligible: request.toolCallId === 'call-auto-b' } }];
    });
    appTwo.apiMock.onPost(/aiConversations:updateUserDecision/).reply((config) => {
      const request = readRequestBody(config.data);
      winnerDecisionRequests.push(request);
      const selected = serverCalls.find((call) => call.id === request.toolCallId);
      let nativeUpdated = 0;
      if (selected?.invokeStatus === 'interrupted') {
        selected.invokeStatus = 'waiting';
        selected.userDecision = request.userDecision;
        nativeUpdated = 1;
      }
      if (request.agentAutoApproval === true) checkpointEnrolled = true;
      const ready =
        checkpointEnrolled && serverCalls.every((call) => !call.willInterrupt || call.invokeStatus === 'waiting');
      const canFinalize = nativeUpdated === 1 && ready && !checkpointIssued;
      if (canFinalize) checkpointIssued = true;
      return [
        200,
        {
          data: {
            updated: checkpointEnrolled ? (canFinalize ? 1 : 0) : nativeUpdated,
            toolCalls: serverCalls.map((call) => ({ ...call })),
            ...(checkpointEnrolled
              ? {
                  agentAutoApprovalCheckpoint: {
                    interruptId,
                    decisionRecorded: nativeUpdated === 1,
                    canFinalize,
                    validSnapshot: true,
                  },
                }
              : {}),
          },
        },
      ];
    });
    vi.spyOn(ClientV2, 'useApp').mockImplementation(
      () => useFlowEngineContext().app as ReturnType<typeof ClientV2.createMockClient>,
    );

    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <InterceptorScope requests={senderRequests}>
          <AutoApprovalBridge runtime={globalRuntime} enabled={false} />
          <ChatBoxRuntimeProvider runtime={globalRuntime}>
            <DecisionControls
              runtime={globalRuntime}
              sessionId={sessionId}
              messageId={messageId}
              actions={[
                {
                  toolCallId: 'call-stale-a',
                  testId: 'send-stale-a',
                  label: 'Approve A',
                  onComplete: () => {
                    staleActionCompleted = true;
                  },
                },
              ]}
            />
          </ChatBoxRuntimeProvider>
        </InterceptorScope>
      </FlowEngineProvider>,
    );

    const staleIdentity = { sessionId, messageId, toolCallId: 'call-stale-a' };
    await waitFor(() => expect(senderRequests.matchingRuntimes(staleIdentity)).toEqual([globalRuntime]));
    await userEvent.click(screen.getByTestId('send-stale-a'));
    await waitFor(() => expect(releaseStalePartial).toBeDefined());
    expect(senderDecisionRequests).toHaveLength(1);
    expect('agentAutoApproval' in senderDecisionRequests[0]).toBe(false);
    expect(checkpointEnrolled).toBe(false);
    expect(stalePayload?.agentAutoApprovalCheckpoint).toBeUndefined();
    expect(stalePayload?.toolCalls).toMatchObject([
      { id: 'call-stale-a', invokeStatus: 'waiting', willInterrupt: true },
      { id: 'call-auto-b', invokeStatus: 'interrupted', willInterrupt: true },
    ]);

    const [staleCall, automaticCall] = calls;
    if (!staleCall || !automaticCall) throw new Error('The two-call stale response fixture is incomplete.');
    const hydratedCalls: ToolCall[] = [
      { ...staleCall, invokeStatus: 'waiting', userDecision: { type: 'approve' } },
      { ...automaticCall, invokeStatus: 'interrupted' },
    ];
    setRuntimeCalls(winnerRuntime, sessionId, messageId, hydratedCalls);
    render(
      <FlowEngineProvider engine={appTwo.flowEngine}>
        <InterceptorScope requests={winnerRequests}>
          <AutoApprovalBridge runtime={winnerRuntime} enabled />
          <ChatBoxRuntimeProvider runtime={winnerRuntime}>
            <DecisionControls
              runtime={winnerRuntime}
              sessionId={sessionId}
              messageId={messageId}
              actions={[{ toolCallId: 'call-auto-b', testId: 'approve-winner-b', label: 'Approve B' }]}
            />
          </ChatBoxRuntimeProvider>
        </InterceptorScope>
      </FlowEngineProvider>,
    );

    await waitFor(() => {
      expect(winnerRuntime.chatMessageModel.sessions[sessionId]?.messages[0]?.content.tool_calls?.[1]?.auto).toBe(true);
    });
    await userEvent.click(screen.getByTestId('approve-winner-b'));
    await waitFor(() => expect(resumeToolCallMock).toHaveBeenCalledTimes(1));
    expect(checkpointEnrolled).toBe(true);
    expect(checkpointIssued).toBe(true);
    expect(winnerDecisionRequests).toHaveLength(1);
    expect(winnerDecisionRequests[0].agentAutoApproval).toBe(true);
    expect(winnerRuntime.chatToolCallModel.isAllWaiting(sessionId, messageId)).toBe(true);
    expect(winnerInvokeA).toHaveBeenCalledTimes(1);
    expect(winnerInvokeB).toHaveBeenCalledTimes(1);

    const reloadedCalls: ToolCall[] = calls.map((call) => ({
      ...call,
      invokeStatus: 'waiting',
      userDecision: { type: 'approve' },
    }));
    hydrateRuntimeCalls(globalRuntime, sessionId, messageId, reloadedCalls);
    expect(globalRuntime.chatToolCallModel.isAllWaiting(sessionId, messageId)).toBe(true);
    expect(
      senderRequests.hasCheckpoint(staleIdentity, [
        { id: 'call-stale-a', willInterrupt: true, invokeStatus: 'waiting' },
        { id: 'call-auto-b', willInterrupt: true, invokeStatus: 'waiting' },
      ]),
    ).toBe(false);

    await act(async () => {
      releaseStalePartial?.();
    });
    await waitFor(() => expect(staleActionCompleted).toBe(true));
    expect(globalRuntime.chatToolCallModel.isAllWaiting(sessionId, messageId)).toBe(true);
    expect(senderInvokeA).not.toHaveBeenCalled();
    expect(senderInvokeB).not.toHaveBeenCalled();
    expect(winnerInvokeA).toHaveBeenCalledTimes(1);
    expect(winnerInvokeB).toHaveBeenCalledTimes(1);
    expect(resumeToolCallMock).toHaveBeenCalledTimes(1);
  });

  it('finalizes a mixed auto and manual checkpoint once across independent app runtimes', async () => {
    const appOne = ClientV2.createMockClient();
    const appTwo = ClientV2.createMockClient();
    additionalApps.push(appTwo);
    const sessionId = 'session-two-tabs';
    const messageId = 'message-two-tabs';
    const interruptId = 'interrupt-two-tabs';
    const calls: ToolCall[] = [
      {
        id: 'call-auto',
        type: 'function',
        name: 'tool-a',
        args: { value: 'A' },
        invokeStatus: 'interrupted',
        auto: false,
        willInterrupt: true,
      },
      {
        id: 'call-manual',
        type: 'function',
        name: 'tool-b',
        args: { value: 'B' },
        invokeStatus: 'interrupted',
        auto: false,
        willInterrupt: true,
      },
      {
        id: 'call-backend-auto',
        type: 'function',
        name: 'backend-tool',
        args: { value: 'already done' },
        invokeStatus: 'done',
        status: 'success',
        auto: true,
        willInterrupt: false,
      },
    ];
    const createRuntime = () => {
      const runtime = createChatBoxRuntime({ mode: 'global' });
      runtime.chatConversationModel.setCurrentConversation(sessionId);
      runtime.chatBoxModel.setCurrentEmployee({ username: 'native-agent' });
      runtime.chatMessageModel.setSessionMessages(sessionId, [
        {
          role: 'assistant',
          content: {
            content: '',
            messageId,
            metadata: { interruptId },
            tool_calls: calls.map((call) => ({ ...call })),
          },
        },
      ]);
      for (const call of calls.filter((item) => item.willInterrupt)) {
        runtime.chatToolCallModel.updateToolCallInvokeStatus(sessionId, messageId, call.id, 'interrupted');
      }
      return runtime;
    };
    const runtimeOne = createRuntime();
    const runtimeTwo = createRuntime();

    const invokeA = vi.fn(async () => ({ status: 'success', content: 'A result' }));
    const invokeB = vi.fn(async () => ({ status: 'success', content: 'B result' }));
    for (const client of [appOne, appTwo]) {
      client.aiManager.toolsManager.registerTools('tool-a', { invoke: invokeA });
      client.aiManager.toolsManager.registerTools('tool-b', { invoke: invokeB });
    }

    let enabled = true;
    let checkpointEnrolled = false;
    let checkpointIssued = false;
    const serverCalls = calls.map((call) => ({ ...call }));
    const decisionRequests: Array<{ app: string; request: RequestBody }> = [];
    let releaseFirstResponse: (() => void) | undefined;

    const makeApi = (client: typeof appOne, appName: string, eligibleCallId?: string) => {
      client.apiMock.onPost(/agentAutoApproval:eligible/).reply((config) => {
        const request = readRequestBody(config.data);
        return [200, { data: { eligible: request.toolCallId === eligibleCallId } }];
      });
      client.apiMock.onPost(/aiConversations:updateUserDecision/).reply((config) => {
        const request = readRequestBody(config.data);
        decisionRequests.push({ app: appName, request });
        const selected = serverCalls.find((call) => call.id === request.toolCallId);
        let nativeUpdated = 0;
        if (selected?.invokeStatus === 'interrupted') {
          selected.invokeStatus = 'waiting';
          selected.userDecision = request.userDecision;
          nativeUpdated = 1;
          if (request.agentAutoApproval === true) checkpointEnrolled = true;
        }

        const interrupting = serverCalls.filter((call) => call.willInterrupt === true);
        const ready = checkpointEnrolled && interrupting.every((call) => call.invokeStatus === 'waiting');
        const canFinalize = nativeUpdated === 1 && ready && !checkpointIssued;
        if (canFinalize) checkpointIssued = true;
        const payload = {
          updated: checkpointEnrolled ? (canFinalize ? 1 : 0) : nativeUpdated,
          toolCalls: serverCalls.map((call) => ({ ...call })),
          ...(checkpointEnrolled
            ? {
                agentAutoApprovalCheckpoint: {
                  interruptId,
                  decisionRecorded: nativeUpdated === 1,
                  canFinalize,
                  validSnapshot: true,
                },
              }
            : {}),
        };

        if (appName === 'tab-one' && request.toolCallId === 'call-auto' && request.agentAutoApproval === true) {
          return new Promise((resolve) => {
            releaseFirstResponse = () => resolve([200, { data: payload }]);
          });
        }
        return [200, { data: payload }];
      });
    };
    makeApi(appOne, 'tab-one', 'call-auto');
    makeApi(appTwo, 'tab-two');

    const TabHarness = ({ runtime, enabled }: { runtime: ChatBoxRuntime; enabled: boolean }) => {
      const requests = React.useMemo(() => new AutoApprovalRequests(), []);
      useAutoApprovalInterceptor(requests);
      const { getDecisionActions } = useToolCallActions({ messageId, runtime });
      const currentCalls = runtime.chatMessageModel.sessions[sessionId]?.messages[0]?.content.tool_calls ?? [];
      const automaticCall = currentCalls.find((call) => call.id === 'call-auto');
      const manualCall = currentCalls.find((call) => call.id === 'call-manual');

      return (
        <AutoApprovalRequestsContext.Provider value={requests}>
          <AutoApprovalBridge runtime={runtime} enabled={enabled} />
          <ChatBoxRuntimeProvider runtime={runtime}>
            <button
              type="button"
              data-testid={`approve-auto-${runtime === runtimeOne ? 'one' : 'two'}`}
              onClick={() => (automaticCall ? getDecisionActions(automaticCall).approve() : undefined)}
            >
              Approve automatic call
            </button>
            <button
              type="button"
              data-testid={`reject-manual-${runtime === runtimeOne ? 'one' : 'two'}`}
              onClick={() => (manualCall ? getDecisionActions(manualCall).reject('Skip B') : undefined)}
            >
              Reject manual call
            </button>
          </ChatBoxRuntimeProvider>
        </AutoApprovalRequestsContext.Provider>
      );
    };

    const TwoApps = () => {
      const [automaticApprovalEnabled, setAutomaticApprovalEnabled] = React.useState(true);
      return (
        <>
          <button
            type="button"
            data-testid="disable-session-auto-approval"
            onClick={() => {
              enabled = false;
              setAutomaticApprovalEnabled(false);
            }}
          >
            Disable session auto-approval
          </button>
          <FlowEngineProvider engine={appOne.flowEngine}>
            <TabHarness runtime={runtimeOne} enabled={automaticApprovalEnabled} />
          </FlowEngineProvider>
          <FlowEngineProvider engine={appTwo.flowEngine}>
            <TabHarness runtime={runtimeTwo} enabled={automaticApprovalEnabled} />
          </FlowEngineProvider>
        </>
      );
    };

    vi.spyOn(ClientV2, 'useApp').mockImplementation(
      () => useFlowEngineContext().app as ReturnType<typeof ClientV2.createMockClient>,
    );
    resumeToolCallMock.mockClear();
    render(<TwoApps />);

    await waitFor(() => {
      const marked = runtimeOne.chatMessageModel.sessions[sessionId]?.messages[0]?.content.tool_calls ?? [];
      expect(marked.find((call) => call.id === 'call-auto')?.auto).toBe(true);
    });
    await userEvent.click(screen.getByTestId('approve-auto-one'));
    await waitFor(() => expect(releaseFirstResponse).toBeDefined());
    expect(checkpointIssued).toBe(false);
    expect(serverCalls.find((call) => call.id === 'call-auto')?.invokeStatus).toBe('waiting');
    expect(serverCalls.find((call) => call.id === 'call-manual')?.invokeStatus).toBe('interrupted');

    await userEvent.click(screen.getByTestId('disable-session-auto-approval'));
    await userEvent.click(screen.getByTestId('reject-manual-two'));

    await waitFor(() => expect(resumeToolCallMock).toHaveBeenCalledTimes(1));
    expect(checkpointIssued).toBe(true);
    expect(decisionRequests.map(({ app: appName, request }) => [appName, request.toolCallId])).toEqual([
      ['tab-one', 'call-auto'],
      ['tab-two', 'call-manual'],
    ]);
    expect(decisionRequests[0].request.agentAutoApproval).toBe(true);
    expect('agentAutoApproval' in decisionRequests[1].request).toBe(false);
    expect(runtimeTwo.chatToolCallModel.isAllWaiting(sessionId, messageId)).toBe(true);
    expect(invokeA).toHaveBeenCalledTimes(1);
    expect(invokeB).not.toHaveBeenCalled();
    expect(resumeToolCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        messageId,
        toolCallIds: ['call-auto', 'call-manual', 'call-backend-auto'],
        toolCallResults: [{ id: 'call-auto', result: { status: 'success', content: 'A result' } }],
      }),
    );

    await act(async () => releaseFirstResponse?.());
    await waitFor(() =>
      expect(runtimeOne.chatToolCallModel.getInvokeStatus(sessionId, messageId, 'call-auto')).toBe('waiting'),
    );
    expect(runtimeOne.chatToolCallModel.getInvokeStatus(sessionId, messageId, 'call-manual')).toBe('interrupted');
    expect(invokeA).toHaveBeenCalledTimes(1);
    expect(resumeToolCallMock).toHaveBeenCalledTimes(1);
    expect(serverCalls.find((call) => call.id === 'call-backend-auto')?.willInterrupt).toBe(false);
    expect(enabled).toBe(false);
  });
});
