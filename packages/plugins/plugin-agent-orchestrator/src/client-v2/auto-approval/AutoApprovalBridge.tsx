// SPDX-License-Identifier: Apache-2.0

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@nocobase/client-v2';
import { observer } from '@nocobase/flow-engine';
import type { ChatBoxRuntime } from '@nocobase/plugin-ai/client-v2';

export type ApprovalIdentity = { sessionId: string; messageId: string; toolCallId: string };
export const approvalIdentityKey = (identity: ApprovalIdentity) => JSON.stringify(Object.values(identity));

type CheckpointToolCall = {
  id: string;
  willInterrupt: boolean;
  invokeStatus?: string;
  userDecision?: unknown;
};

function checkpointCalls(value: unknown): CheckpointToolCall[] | null {
  if (!Array.isArray(value)) return null;
  const result: CheckpointToolCall[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const call = item as Record<string, unknown>;
    if (typeof call.id !== 'string' || typeof call.willInterrupt !== 'boolean') return null;
    result.push({
      id: call.id,
      willInterrupt: call.willInterrupt,
      invokeStatus: typeof call.invokeStatus === 'string' ? call.invokeStatus : undefined,
      userDecision: call.userDecision,
    });
  }
  return result;
}

export class AutoApprovalRequests {
  private pending = new Map<
    string,
    {
      identity: ApprovalIdentity;
      owners: Map<object, { rejected: () => void; active: () => boolean; runtime?: ChatBoxRuntime }>;
    }
  >();
  private groups = new Map<string, { key: string; owner: object }>();
  private listeners = new Set<() => void>();
  private runtimes = new Map<ChatBoxRuntime, number>();
  private checkpoints = new Map<string, { interruptId: string; callIds: Set<string> }>();
  private inFlight = new Map<string, number>();

  private groupKey(identity: ApprovalIdentity) {
    return JSON.stringify([identity.sessionId, identity.messageId]);
  }

  reserve(identity: ApprovalIdentity, owner: object) {
    const group = this.groupKey(identity);
    if (this.groups.has(group)) return false;
    this.groups.set(group, { key: approvalIdentityKey(identity), owner });
    return true;
  }

  release(identity: ApprovalIdentity, owner: object) {
    const group = this.groupKey(identity);
    const held = this.groups.get(group);
    if (!held || held.key !== approvalIdentityKey(identity) || held.owner !== owner) return;
    this.groups.delete(group);
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  registerRuntime(runtime: ChatBoxRuntime) {
    this.runtimes.set(runtime, (this.runtimes.get(runtime) ?? 0) + 1);
    return () => {
      const count = this.runtimes.get(runtime) ?? 0;
      if (count <= 1) this.runtimes.delete(runtime);
      else this.runtimes.set(runtime, count - 1);
    };
  }

  matchingRuntimes(identity: ApprovalIdentity) {
    return [...this.runtimes.keys()].filter((runtime) => {
      if (runtime.chatConversationModel.currentConversation !== identity.sessionId) return false;
      const messages = runtime.chatMessageModel.sessions[identity.sessionId]?.messages;
      const message = messages?.find((item) => String(item.content?.messageId) === identity.messageId);
      return message?.content.tool_calls?.some((call) => call.id === identity.toolCallId);
    });
  }

  beginRequest(identity: ApprovalIdentity) {
    const group = this.groupKey(identity);
    this.inFlight.set(group, (this.inFlight.get(group) ?? 0) + 1);
  }

  endRequest(identity: ApprovalIdentity) {
    const group = this.groupKey(identity);
    const count = this.inFlight.get(group) ?? 0;
    if (count <= 1) {
      this.inFlight.delete(group);
      this.checkpoints.delete(group);
    } else {
      this.inFlight.set(group, count - 1);
    }
  }

  rememberCheckpoint(identity: ApprovalIdentity, interruptId: string, calls: CheckpointToolCall[]) {
    this.checkpoints.set(this.groupKey(identity), { interruptId, callIds: new Set(calls.map((call) => call.id)) });
  }

  hasCheckpoint(identity: ApprovalIdentity, calls: CheckpointToolCall[]) {
    const checkpoint = this.checkpoints.get(this.groupKey(identity));
    return (
      !!checkpoint && checkpoint.callIds.size === calls.length && calls.every((call) => checkpoint.callIds.has(call.id))
    );
  }

  synchronize(identity: ApprovalIdentity, interruptId: string | undefined, calls: CheckpointToolCall[]) {
    const callIds = new Set(calls.map((call) => call.id));
    const waiting = calls.filter((call) => call.willInterrupt && call.invokeStatus === 'waiting');
    const matched = new Set<ChatBoxRuntime>();
    for (const runtime of this.runtimes.keys()) {
      if (runtime.chatConversationModel.currentConversation !== identity.sessionId) continue;
      const messages = runtime.chatMessageModel.sessions[identity.sessionId]?.messages;
      const message = messages?.find((item) => String(item.content?.messageId) === identity.messageId);
      const current = message?.content.tool_calls;
      const metadata = message?.content.metadata as Record<string, unknown> | undefined;
      if (
        !current ||
        current.length !== callIds.size ||
        current.some((item) => !callIds.has(item.id)) ||
        (typeof interruptId === 'string' &&
          typeof metadata?.interruptId === 'string' &&
          metadata.interruptId !== interruptId) ||
        waiting.some((call) => {
          const status = runtime.chatToolCallModel.getInvokeStatus(identity.sessionId, identity.messageId, call.id);
          return status !== undefined && status !== 'interrupted' && status !== 'waiting';
        })
      )
        continue;
      matched.add(runtime);
      for (const call of waiting) {
        const status = runtime.chatToolCallModel.getInvokeStatus(identity.sessionId, identity.messageId, call.id);
        if (status === undefined || status === 'interrupted') {
          runtime.chatToolCallModel.updateToolCallInvokeStatus(
            identity.sessionId,
            identity.messageId,
            call.id,
            'waiting',
          );
        }
      }
      runtime.chatMessageModel.setSessionMessages(identity.sessionId, (entries) =>
        entries.map((entry) => {
          if (String(entry.content?.messageId) !== identity.messageId) return entry;
          return {
            ...entry,
            content: {
              ...entry.content,
              tool_calls: entry.content.tool_calls?.map((item) => {
                const call = waiting.find((candidate) => candidate.id === item.id);
                if (!call || item.invokeStatus !== 'interrupted') return item;
                return { ...item, invokeStatus: 'waiting', userDecision: call.userDecision };
              }),
            },
          };
        }),
      );
    }
    return matched;
  }

  mark(
    identity: ApprovalIdentity,
    rejected: () => void,
    owner: object = rejected,
    active = () => true,
    runtime?: ChatBoxRuntime,
  ) {
    const key = approvalIdentityKey(identity);
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { identity, owners: new Map() };
      this.pending.set(key, entry);
    }
    entry.owners.set(owner, { rejected, active, runtime });
  }

  has(identity: ApprovalIdentity) {
    const owners = this.pending.get(approvalIdentityKey(identity))?.owners.values() ?? [];
    return [...owners].some((entry) => entry.active());
  }

  automaticRuntime(identity: ApprovalIdentity) {
    const owners = this.pending.get(approvalIdentityKey(identity))?.owners.values() ?? [];
    return [...owners].find((entry) => entry.active())?.runtime;
  }

  reject(identity: ApprovalIdentity) {
    for (const entry of this.pending.get(approvalIdentityKey(identity))?.owners.values() ?? []) entry.rejected();
  }

  clear(identity: ApprovalIdentity, owner?: object) {
    const key = approvalIdentityKey(identity);
    const entry = this.pending.get(key);
    if (!owner) this.pending.delete(key);
    else if (entry) {
      entry.owners.delete(owner);
      if (!entry.owners.size) this.pending.delete(key);
    }
    if (owner) this.release(identity, owner);
  }

  identities(owner?: object) {
    return [...this.pending.values()].filter((item) => !owner || item.owners.has(owner)).map((item) => item.identity);
  }
}

export const AutoApprovalRequestsContext = createContext<AutoApprovalRequests | null>(null);

/** Mark only native approvals for which this plugin requested auto-approval. */
export function useAutoApprovalInterceptor(requests: AutoApprovalRequests) {
  const { apiClient } = useApp();
  useEffect(() => {
    const outgoing = new WeakMap<
      object,
      { identity: ApprovalIdentity; automatic: boolean; origin?: ChatBoxRuntime; runtimes: ChatBoxRuntime[] }
    >();
    const interceptor = apiClient.axios.interceptors.request.use((config) => {
      if (!config.url?.split('?')[0].endsWith('aiConversations:updateUserDecision')) return config;
      const data = config.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return config;
      const { sessionId, messageId, toolCallId, userDecision } = data as Record<string, unknown>;
      if (
        typeof sessionId !== 'string' ||
        (typeof messageId !== 'string' && typeof messageId !== 'number') ||
        typeof toolCallId !== 'string' ||
        !userDecision ||
        typeof userDecision !== 'object'
      )
        return config;
      const identity = { sessionId, messageId: String(messageId), toolCallId };
      const automatic = (userDecision as { type?: unknown }).type === 'approve' && requests.has(identity);
      if (automatic) {
        config.data = { ...data, agentAutoApproval: true };
      }
      requests.beginRequest(identity);
      outgoing.set(config, {
        identity,
        automatic,
        origin: automatic ? requests.automaticRuntime(identity) : undefined,
        runtimes: requests.matchingRuntimes(identity),
      });
      return config;
    });
    const responseInterceptor = apiClient.axios.interceptors.response.use(
      (response) => {
        const request = outgoing.get(response.config);
        if (!request) return response;
        const { identity, automatic } = request;
        try {
          const payload = response.data?.data as Record<string, unknown> | undefined;
          const marker = payload?.agentAutoApprovalCheckpoint;
          const checkpoint = marker && typeof marker === 'object' ? (marker as Record<string, unknown>) : undefined;
          const calls = checkpointCalls(payload?.toolCalls);
          if (checkpoint && typeof checkpoint.interruptId === 'string' && checkpoint.validSnapshot === true && calls) {
            requests.rememberCheckpoint(identity, checkpoint.interruptId, calls);
            const matched = requests.synchronize(identity, checkpoint.interruptId, calls);
            if (
              checkpoint.canFinalize !== true ||
              (automatic
                ? !request.origin || !matched.has(request.origin)
                : !request.runtimes.some((runtime) => matched.has(runtime)))
            ) {
              if (payload) payload.updated = 0;
            }
            if (automatic && checkpoint.decisionRecorded !== true) {
              const selected = calls.find((call) => call.id === identity.toolCallId);
              if (selected?.invokeStatus !== 'waiting') requests.reject(identity);
            }
          } else if (
            !checkpoint &&
            calls &&
            (request.runtimes.length > 0 ||
              (automatic && !!request.origin) ||
              requests.hasCheckpoint(identity, calls)) &&
            calls.length > 1 &&
            new Set(calls.map((call) => call.id)).size === calls.length &&
            calls.some((call) => call.id === identity.toolCallId && call.willInterrupt) &&
            calls.some((call) => call.willInterrupt && call.invokeStatus !== 'waiting')
          ) {
            // A native partial response may arrive after another view has finished the checkpoint.
            // Apply only decisions already persisted, and do not let this callback run the tools.
            requests.synchronize(identity, undefined, calls);
            if (automatic && payload?.updated === 0) {
              const selected = calls.find((call) => call.id === identity.toolCallId);
              if (selected?.invokeStatus !== 'waiting') requests.reject(identity);
            }
            if (payload) payload.updated = 0;
          } else if (!checkpoint && calls && requests.hasCheckpoint(identity, calls)) {
            // A manual request can have left the server just before this checkpoint was enrolled.
            // Its delayed response must not run a second native finalizer in the same runtime.
            if (payload) payload.updated = 0;
          } else if (automatic && payload?.updated === 0) {
            requests.reject(identity);
          }
        } finally {
          requests.endRequest(identity);
        }
        return response;
      },
      (error) => {
        const request = error?.config && outgoing.get(error.config);
        if (request) {
          if (request.automatic) requests.reject(request.identity);
          requests.endRequest(request.identity);
        }
        return Promise.reject(error);
      },
    );
    return () => {
      apiClient.axios.interceptors.request.eject(interceptor);
      apiClient.axios.interceptors.response.eject(responseInterceptor);
    };
  }, [apiClient, requests]);
}

export const AutoApprovalBridge = observer(({ runtime, enabled }: { runtime: ChatBoxRuntime; enabled: boolean }) => {
  const { apiClient } = useApp();
  const requests = useContext(AutoApprovalRequestsContext);
  const sessionId = runtime.chatConversationModel.currentConversation;
  const messages = runtime.chatMessageModel.sessions[sessionId || '__draft__']?.messages;
  const toolCalls = runtime.chatToolCallModel.sessions[sessionId || '__draft__']?.toolCalls;
  const checked = useRef(new Set<string>());
  const marked = useRef(new Map<string, ApprovalIdentity>());
  const reserved = useRef(new Map<string, ApprovalIdentity>());
  const owner = useRef({});
  const [queueVersion, setQueueVersion] = useState(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => requests?.registerRuntime(runtime), [requests, runtime]);
  useEffect(() => requests?.subscribe(() => setQueueVersion((value) => value + 1)), [requests]);

  const restore = useCallback(
    (identity: ApprovalIdentity) => {
      runtime.chatMessageModel.setSessionMessages(identity.sessionId, (current) =>
        current.map((entry) => {
          if (String(entry.content?.messageId) !== identity.messageId) return entry;
          return {
            ...entry,
            content: {
              ...entry.content,
              tool_calls: entry.content.tool_calls?.map((call) =>
                call.id === identity.toolCallId ? { ...call, auto: false } : call,
              ),
            },
          };
        }),
      );
    },
    [runtime],
  );

  const candidates = useMemo(() => {
    if (!sessionId || !messages || !toolCalls || !enabled) return [];
    return messages.flatMap((entry) => {
      const content = entry.content;
      const messageId = content?.messageId;
      if (content?.from === 'sub-agent' || !messageId) return [];
      if (content.tool_calls?.some((call) => call.invokeStatus === 'interrupted' && call.auto === true)) return [];
      return (content.tool_calls || [])
        .filter(
          (call) =>
            call.invokeStatus === 'interrupted' &&
            call.auto === false &&
            runtime.chatToolCallModel.isInterrupted(sessionId, messageId, call.id),
        )
        .map((call) => ({ sessionId, messageId: String(messageId), toolCallId: call.id }));
    });
  }, [enabled, messages, runtime, sessionId, toolCalls]);

  useEffect(() => {
    if (!enabled || !sessionId || !requests) return;
    for (const identity of candidates) {
      const key = approvalIdentityKey(identity);
      if (checked.current.has(key) || !requests.reserve(identity, owner.current)) continue;
      checked.current.add(key);
      reserved.current.set(key, identity);
      apiClient
        .request({
          url: 'agentAutoApproval:eligible',
          method: 'post',
          data: identity,
          skipNotify: true,
        })
        .then((response) => {
          const live = runtime.chatMessageModel.sessions[identity.sessionId]?.messages.find(
            (entry) => String(entry.content?.messageId) === identity.messageId && entry.content?.from !== 'sub-agent',
          );
          const calls = live?.content?.tool_calls;
          const call = calls?.find((item) => item.id === identity.toolCallId);
          if (
            response.data?.data?.eligible !== true ||
            !enabledRef.current ||
            runtime.chatConversationModel.currentConversation !== identity.sessionId ||
            !runtime.chatToolCallModel.isInterrupted(identity.sessionId, identity.messageId, identity.toolCallId) ||
            !call ||
            call.auto !== false ||
            call.invokeStatus !== 'interrupted' ||
            calls?.some((item) => item.invokeStatus === 'interrupted' && item.auto === true)
          ) {
            requests.release(identity, owner.current);
            reserved.current.delete(key);
            return;
          }
          requests.mark(
            identity,
            () => {
              enabledRef.current = false;
              restore(identity);
              window.dispatchEvent(new CustomEvent('agent-auto-approval-stale', { detail: identity.sessionId }));
            },
            owner.current,
            () => enabledRef.current,
            runtime,
          );
          marked.current.set(key, identity);
          runtime.chatMessageModel.setSessionMessages(identity.sessionId, (current) =>
            current.map((entry) => {
              if (String(entry.content?.messageId) !== identity.messageId || entry.content?.from === 'sub-agent')
                return entry;
              return {
                ...entry,
                content: {
                  ...entry.content,
                  tool_calls: entry.content.tool_calls?.map((call) => {
                    if (call.id !== identity.toolCallId || call.invokeStatus !== 'interrupted') return call;
                    const guarded = { ...call };
                    Object.defineProperty(guarded, 'auto', {
                      enumerable: true,
                      configurable: true,
                      get: () =>
                        enabledRef.current &&
                        runtime.chatConversationModel.currentConversation === identity.sessionId &&
                        runtime.chatToolCallModel.isInterrupted(
                          identity.sessionId,
                          identity.messageId,
                          identity.toolCallId,
                        ),
                    });
                    return guarded;
                  }),
                },
              };
            }),
          );
        })
        .catch(() => {
          requests.release(identity, owner.current);
          reserved.current.delete(key);
          // Leave the normal approval controls available when eligibility cannot be checked.
        });
    }
  }, [apiClient, candidates, enabled, queueVersion, requests, restore, runtime, sessionId]);

  useEffect(() => {
    if (enabled) return;
    for (const identity of marked.current.values()) restore(identity);
    checked.current.clear();
  }, [enabled, restore]);

  useEffect(() => {
    for (const identity of requests?.identities(owner.current) ?? []) {
      if (identity.sessionId !== sessionId) continue;
      const entry = runtime.chatMessageModel.sessions[identity.sessionId]?.messages.find(
        (item) => String(item.content?.messageId) === identity.messageId,
      );
      const call = entry?.content?.tool_calls?.find((item) => item.id === identity.toolCallId);
      if (
        call &&
        Object.getOwnPropertyDescriptor(call, 'auto')?.get &&
        !runtime.chatToolCallModel.isInterrupted(identity.sessionId, identity.messageId, identity.toolCallId)
      ) {
        restore(identity);
      } else if (!call || call.auto !== true || call.invokeStatus !== 'interrupted') {
        requests?.clear(identity, owner.current);
        marked.current.delete(approvalIdentityKey(identity));
        reserved.current.delete(approvalIdentityKey(identity));
      }
    }
  }, [messages, requests, restore, runtime, sessionId, toolCalls]);

  useEffect(
    () => () => {
      enabledRef.current = false;
      for (const identity of marked.current.values()) {
        restore(identity);
        setTimeout(() => requests?.clear(identity, owner.current), 0);
      }
      for (const [key, identity] of reserved.current) {
        if (!marked.current.has(key)) requests?.release(identity, owner.current);
      }
      marked.current.clear();
      reserved.current.clear();
    },
    [requests, restore],
  );

  return null;
});
