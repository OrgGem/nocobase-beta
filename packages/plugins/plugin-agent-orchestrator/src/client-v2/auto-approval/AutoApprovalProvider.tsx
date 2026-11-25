// SPDX-License-Identifier: Apache-2.0

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ThunderboltOutlined } from '@ant-design/icons';
import { Switch, message } from 'antd';
import { useApp } from '@nocobase/client-v2';
import { observer, useFlowContext } from '@nocobase/flow-engine';
import { getGlobalChatBoxRuntime, type AIManager, type ChatBoxRuntime } from '@nocobase/plugin-ai/client-v2';
import { useT } from '../skill-hub/locale';
import {
  AutoApprovalBridge,
  AutoApprovalRequests,
  AutoApprovalRequestsContext,
  useAutoApprovalInterceptor,
} from './AutoApprovalBridge';

type Mount = { key: number; runtime: ChatBoxRuntime; defaultSystemMessage?: () => string | undefined };
type MenuControl = {
  enabled: boolean;
  disabled: boolean;
  label: string;
  toggle: (next: boolean) => void;
};
type MenuStore = { controls: Map<ChatBoxRuntime, MenuControl>; listeners: Set<() => void> };
type ContextModel = {
  use?: string;
  constructor?: { name?: string };
  parent?: { chatBoxRuntime?: ChatBoxRuntime };
};

const menuStoresByApp = new WeakMap<object, MenuStore>();

function getMenuStore(app: object) {
  let store = menuStoresByApp.get(app);
  if (!store) {
    store = { controls: new Map(), listeners: new Set() };
    menuStoresByApp.set(app, store);
  }
  return store;
}

export function registerAutoApprovalWorkContext(manager?: Pick<AIManager, 'getWorkContext' | 'registerWorkContext'>) {
  if (manager && !manager.getWorkContext('agent-auto-approval')) {
    manager.registerWorkContext('agent-auto-approval', { menu: { Component: AutoApprovalMenu } });
  }
}

export function AutoApprovalMenu() {
  const app = useApp();
  const t = useT();
  const context = useFlowContext<{ model?: ContextModel }>();
  const model = context?.model;
  const isChatCore = model?.use === 'AIChatBoxCoreModel' || model?.constructor?.name === 'AIChatBoxCoreModel';
  const runtime = model ? (isChatCore ? model.parent?.chatBoxRuntime : undefined) : getGlobalChatBoxRuntime();
  const menuStore = useMemo(() => getMenuStore(app), [app]);
  const [control, setControl] = useState<MenuControl | undefined>(() =>
    runtime ? menuStore.controls.get(runtime) : undefined,
  );
  const visible = !!runtime && !!control;
  const id = React.useId();
  const hiddenItem = useRef<{ item: HTMLElement; display: string }>();

  useLayoutEffect(() => {
    const sync = () => setControl(runtime ? menuStore.controls.get(runtime) : undefined);
    menuStore.listeners.add(sync);
    sync();
    return () => {
      menuStore.listeners.delete(sync);
    };
  }, [menuStore, runtime]);

  const setElement = useCallback(
    (element: HTMLElement | null) => {
      if (hiddenItem.current) {
        hiddenItem.current.item.style.display = hiddenItem.current.display;
        hiddenItem.current = undefined;
      }
      if (element && !visible) {
        const item = element.closest<HTMLElement>('.ant-dropdown-menu-item');
        if (item) {
          hiddenItem.current = { item, display: item.style.display };
          item.style.display = 'none';
        }
      }
    },
    [visible],
  );

  if (!control) {
    return <span id={id} ref={setElement} data-agent-auto-approval-menu="true" />;
  }

  return (
    <label
      id={id}
      ref={setElement}
      data-agent-auto-approval-menu="true"
      htmlFor={`${id}-switch`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        margin: '-5px -12px',
        padding: '5px 12px',
        cursor: control.disabled ? 'not-allowed' : 'pointer',
      }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (['Enter', ' ', 'ArrowLeft', 'ArrowRight'].includes(event.key)) event.stopPropagation();
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <ThunderboltOutlined aria-hidden="true" />
        <span>{t('Auto accept')}</span>
      </span>
      <Switch
        id={`${id}-switch`}
        size="small"
        aria-label={control.label}
        checked={control.enabled}
        onChange={control.toggle}
        disabled={control.disabled}
      />
    </label>
  );
}

/** Keep the approval bridge active for each live chat runtime, including when its menu is closed. */
export function AutoApprovalProvider({ children }: React.PropsWithChildren) {
  const app = useApp();
  const [mounts, setMounts] = useState<Mount[]>([]);
  const requests = useMemo(() => new AutoApprovalRequests(), []);
  useAutoApprovalInterceptor(requests);

  useEffect(() => {
    const active = new Map<ChatBoxRuntime, Mount>();
    let nextKey = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    const selector = '.ai-chat-sender-tools, .ai-chat-sender-compact-toolbar';
    const discover = () => {
      timer = undefined;
      const runtimes = new Map<ChatBoxRuntime, (() => string | undefined) | undefined>([
        [getGlobalChatBoxRuntime(), undefined],
      ]);
      let engine: typeof app.flowEngine | undefined = app.flowEngine;
      const engines = new Set<typeof app.flowEngine>();
      while (engine && !engines.has(engine)) {
        engines.add(engine);
        engine.forEachModel((model) => {
          const block = model as unknown as { chatBoxRuntime?: ChatBoxRuntime; props?: { systemPrompt?: string } };
          if (block.chatBoxRuntime) runtimes.set(block.chatBoxRuntime, () => block.props?.systemPrompt);
        });
        engine = engine.nextEngine;
      }

      const next = new Map<ChatBoxRuntime, { defaultSystemMessage?: () => string | undefined }>();
      let ownedToolbars = 0;
      const roots = [...runtimes]
        .map(([runtime, defaultSystemMessage]) => ({
          root: runtime.chatBoxModel.chatBoxRef?.current,
          runtime,
          defaultSystemMessage,
        }))
        .filter(
          (
            item,
          ): item is {
            root: HTMLDivElement;
            runtime: ChatBoxRuntime;
            defaultSystemMessage: (() => string | undefined) | undefined;
          } => !!item.root?.isConnected,
        );
      for (const { root, runtime, defaultSystemMessage } of roots) {
        for (const toolbar of root.querySelectorAll<HTMLElement>(selector)) {
          if (roots.some((other) => other.root !== root && root.contains(other.root) && other.root.contains(toolbar))) {
            continue;
          }
          next.set(runtime, { defaultSystemMessage });
          ownedToolbars += 1;
        }
      }
      let changed = false;
      for (const runtime of active.keys()) {
        if (!next.has(runtime)) {
          active.delete(runtime);
          changed = true;
        }
      }
      for (const [runtime, { defaultSystemMessage }] of next) {
        if (active.has(runtime)) continue;
        active.set(runtime, { key: nextKey++, runtime, defaultSystemMessage });
        changed = true;
      }
      if (changed) setMounts([...active.values()]);
      if (document.querySelectorAll(selector).length > ownedToolbars && retries < 5) {
        retries += 1;
        timer = setTimeout(discover, 50);
      }
    };
    const schedule = () => {
      if (!timer) timer = setTimeout(discover, 40);
    };
    const containsToolbar = (node: Node) =>
      node instanceof Element && (node.matches(selector) || !!node.querySelector(selector));
    const observer = new MutationObserver((records) => {
      if (records.some((record) => [...record.addedNodes, ...record.removedNodes].some(containsToolbar))) {
        retries = 0;
        schedule();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    schedule();
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [app]);

  return (
    <AutoApprovalRequestsContext.Provider value={requests}>
      {children}
      {mounts.map(({ key, runtime, defaultSystemMessage }) => (
        <AutoApprovalToggle key={key} runtime={runtime} defaultSystemMessage={defaultSystemMessage} />
      ))}
    </AutoApprovalRequestsContext.Provider>
  );
}

export const AutoApprovalToggle = observer(
  ({ runtime, defaultSystemMessage }: { runtime: ChatBoxRuntime; defaultSystemMessage?: () => string | undefined }) => {
    const app = useApp();
    const t = useT();
    const { chatBoxModel, chatConversationModel, chatMessageModel, chatToolCallModel } = runtime;
    const sessionId = chatConversationModel.currentConversation;
    const [setting, setSetting] = useState<{ sessionId?: string; enabled: boolean }>({ enabled: false });
    const enabled = !!sessionId && setting.sessionId === sessionId && setting.enabled;
    const [loading, setLoading] = useState(false);
    const [available, setAvailable] = useState(true);
    const pendingSession = useRef<string>();
    const generation = useRef(0);
    const syncScope = `${app.apiClient.appName || ''}:${app.apiClient.storagePrefix}`;

    const notifySettingChanged = (changedSession: string) => {
      window.dispatchEvent(
        new CustomEvent('agent-auto-approval-changed', { detail: { scope: syncScope, sessionId: changedSession } }),
      );
      if (typeof BroadcastChannel !== 'undefined') {
        try {
          const channel = new BroadcastChannel(`agent-auto-approval:${syncScope}:${changedSession}`);
          channel.postMessage(null);
          channel.close();
        } catch {
          // Focus refresh provides a fallback where browser channels are unavailable.
        }
      }
    };

    useEffect(() => {
      const request = ++generation.current;
      setSetting({ sessionId, enabled: false });
      if (!sessionId) {
        setLoading(false);
        setAvailable(true);
        return;
      }
      if (pendingSession.current === sessionId) return;
      setLoading(true);
      const loadSetting = async () => {
        try {
          const response = await app.apiClient.request({
            url: 'agentAutoApproval:get',
            method: 'post',
            data: { sessionId },
          });
          if (request === generation.current && chatConversationModel.currentConversation === sessionId) {
            setSetting({ sessionId, enabled: response.data?.data?.enabled === true });
            setAvailable(true);
          }
        } catch {
          if (request === generation.current) setAvailable(false);
        } finally {
          if (request === generation.current) setLoading(false);
        }
      };
      loadSetting();
      return () => {
        generation.current += 1;
      };
    }, [app.apiClient, chatConversationModel, sessionId]);

    useEffect(() => {
      const refreshAfterAuth = () => {
        setSetting({ sessionId, enabled: false });
        if (!sessionId) return;
        setAvailable(false);
        setLoading(true);
        const request = ++generation.current;
        app.apiClient
          .request({ url: 'agentAutoApproval:get', method: 'post', data: { sessionId }, skipNotify: true })
          .then((response) => {
            if (request === generation.current && chatConversationModel.currentConversation === sessionId) {
              setSetting({ sessionId, enabled: response.data?.data?.enabled === true });
              setAvailable(true);
              setLoading(false);
            }
          })
          .catch(() => {
            if (request === generation.current) {
              setAvailable(false);
              setLoading(false);
            }
          });
      };
      app.eventBus.addEventListener('auth:tokenChanged', refreshAfterAuth);
      app.eventBus.addEventListener('auth:roleChanged', refreshAfterAuth);
      return () => {
        app.eventBus.removeEventListener('auth:tokenChanged', refreshAfterAuth);
        app.eventBus.removeEventListener('auth:roleChanged', refreshAfterAuth);
      };
    }, [app.apiClient, app.eventBus, chatConversationModel, sessionId]);

    useEffect(() => {
      const refresh = (event: Event) => {
        if (!sessionId || (event as CustomEvent<string>).detail !== sessionId) return;
        const request = ++generation.current;
        setLoading(true);
        app.apiClient
          .request({ url: 'agentAutoApproval:get', method: 'post', data: { sessionId }, skipNotify: true })
          .then((response) => {
            if (request === generation.current && chatConversationModel.currentConversation === sessionId) {
              setSetting({ sessionId, enabled: response.data?.data?.enabled === true });
              setAvailable(true);
              setLoading(false);
            }
          })
          .catch(() => {
            if (request === generation.current) {
              setAvailable(false);
              setLoading(false);
            }
          });
      };
      window.addEventListener('agent-auto-approval-stale', refresh);
      return () => window.removeEventListener('agent-auto-approval-stale', refresh);
    }, [app.apiClient, chatConversationModel, sessionId]);

    useEffect(() => {
      if (!sessionId) return;
      const refresh = () => {
        if (pendingSession.current === sessionId || chatConversationModel.currentConversation !== sessionId) return;
        const request = ++generation.current;
        setLoading(true);
        app.apiClient
          .request({ url: 'agentAutoApproval:get', method: 'post', data: { sessionId }, skipNotify: true })
          .then((response) => {
            if (request === generation.current && chatConversationModel.currentConversation === sessionId) {
              setSetting({ sessionId, enabled: response.data?.data?.enabled === true });
              setAvailable(true);
              setLoading(false);
            }
          })
          .catch(() => {
            if (request === generation.current) {
              setAvailable(false);
              setLoading(false);
            }
          });
      };
      const onChange = (event: Event) => {
        const detail = (event as CustomEvent<{ scope?: string; sessionId?: string }>).detail;
        if (detail?.scope === syncScope && detail.sessionId === sessionId) refresh();
      };
      let channel: BroadcastChannel | undefined;
      if (typeof BroadcastChannel !== 'undefined') {
        try {
          channel = new BroadcastChannel(`agent-auto-approval:${syncScope}:${sessionId}`);
          channel.onmessage = refresh;
        } catch {
          // The next focus event will refresh the active session.
        }
      }
      window.addEventListener('agent-auto-approval-changed', onChange);
      window.addEventListener('focus', refresh);
      return () => {
        channel?.close();
        window.removeEventListener('agent-auto-approval-changed', onChange);
        window.removeEventListener('focus', refresh);
      };
    }, [app.apiClient, chatConversationModel, sessionId, syncScope]);

    const toggle = async (next: boolean) => {
      if (loading || !available || chatBoxModel.readonly || !chatBoxModel.currentEmployee || next === enabled) return;
      let target = sessionId;
      const employee = chatBoxModel.currentEmployee;
      const draftState = chatMessageModel.sessions.__draft__;
      if (!next) setSetting({ sessionId, enabled: false });
      setLoading(true);
      generation.current += 1;
      try {
        if (!target) {
          chatBoxModel.setReadonly(true);
          const draft = chatMessageModel.getSessionState();
          const scope = runtime.mode === 'block' ? await runtime.getScope?.({ operation: 'create' }) : undefined;
          const model = chatBoxModel.model;
          const response = await app.apiClient.resource('aiConversations').create({
            values: {
              aiEmployee: employee,
              systemMessage: draft.systemMessage || defaultSystemMessage?.(),
              skillSettings: draft.skillSettings,
              scope,
              modelSettings: model ? { llmService: model.llmService, model: model.model } : undefined,
            },
          });
          const conversation = response.data?.data;
          const created = conversation?.sessionId;
          if (typeof created !== 'string' || !created) throw new Error('Conversation creation failed.');
          if (
            chatConversationModel.currentConversation ||
            chatBoxModel.currentEmployee?.username !== employee.username ||
            chatMessageModel.sessions.__draft__ !== draftState
          )
            return;
          target = created;
          pendingSession.current = target;
          chatMessageModel.migrateSessionState(undefined, target);
          chatToolCallModel.migrateSessionState('__draft__', target);
          if (!chatConversationModel.keyword) {
            chatConversationModel.setConversations((current) => [
              { ...conversation, sessionId: target, aiEmployee: employee, read: true },
              ...current.filter((item) => item.sessionId !== target),
            ]);
          }
          chatConversationModel.setCurrentConversation(target);
        } else {
          pendingSession.current = target;
        }
        const response = await app.apiClient.request({
          url: 'agentAutoApproval:set',
          method: 'post',
          data: { sessionId: target, enabled: next },
        });
        if (chatConversationModel.currentConversation === target) {
          setSetting({ sessionId: target, enabled: response.data?.data?.enabled === true });
          setAvailable(true);
        }
        notifySettingChanged(target);
      } catch {
        message.error(t('Could not update automatic approval'));
        if (target && chatConversationModel.currentConversation === target) {
          try {
            const response = await app.apiClient.request({
              url: 'agentAutoApproval:get',
              method: 'post',
              data: { sessionId: target },
              skipNotify: true,
            });
            if (chatConversationModel.currentConversation === target) {
              setSetting({ sessionId: target, enabled: response.data?.data?.enabled === true });
              setAvailable(true);
            }
          } catch {
            if (chatConversationModel.currentConversation === target) setAvailable(false);
          }
        }
      } finally {
        if (!sessionId && !runtime.workflowTaskModel.currentWorkflowTask) chatBoxModel.setReadonly(false);
        pendingSession.current = undefined;
        if (chatConversationModel.currentConversation === target || !chatConversationModel.currentConversation) {
          setLoading(false);
        }
      }
    };

    const disabled = loading || !available || !chatBoxModel.currentEmployee || chatBoxModel.readonly;
    const label = t(
      !available
        ? 'Automatic approval unavailable'
        : enabled
          ? 'Disable automatic approval'
          : 'Enable automatic approval',
    );
    const toggleRef = useRef(toggle);
    toggleRef.current = toggle;
    const stableToggle = useCallback((next: boolean) => {
      toggleRef.current(next);
    }, []);

    useLayoutEffect(() => {
      const store = getMenuStore(app);
      return () => {
        store.controls.delete(runtime);
        store.listeners.forEach((listener) => listener());
      };
    }, [app, runtime]);

    useLayoutEffect(() => {
      const store = getMenuStore(app);
      store.controls.set(runtime, { enabled, disabled, label, toggle: stableToggle });
      store.listeners.forEach((listener) => listener());
    }, [app, disabled, enabled, label, runtime, stableToggle]);

    return <AutoApprovalBridge runtime={runtime} enabled={enabled} />;
  },
);
