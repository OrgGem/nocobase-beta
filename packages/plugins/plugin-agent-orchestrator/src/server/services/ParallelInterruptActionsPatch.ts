// SPDX-License-Identifier: Apache-2.0

import { AIEmployee } from '@nocobase/plugin-ai/server';

export type InterruptActionRequest = {
  name: string;
  args?: unknown;
  description?: string;
};

export type InterruptReviewConfig = {
  actionName: string;
  allowedDecisions?: string[];
};

export type InterruptPayload = {
  actionRequests?: InterruptActionRequest[];
  reviewConfigs?: InterruptReviewConfig[];
};

export type InterruptAction = {
  order: number;
  description?: string;
  allowedDecisions?: string[];
  toolCall?: { id: string; name: string };
  currentConversation?: {
    sessionId: string;
    from: string;
    username: string;
  };
};

type ToInterruptActionsFn = (interrupt?: InterruptPayload) => Map<string, InterruptAction>;

const PATCH_STATE_KEY = Symbol.for('plugin-agent-orchestrator.parallelInterruptActionsPatch');

type PatchState = {
  original: ToInterruptActionsFn;
  wrapped: ToInterruptActionsFn;
  owners: Set<symbol>;
};

export type PatchableAIEmployeePrototype = {
  toInterruptActions?: ToInterruptActionsFn;
  [PATCH_STATE_KEY]?: PatchState;
};

function parseInterruptDescription(description?: string): Record<string, unknown> | null {
  if (typeof description !== 'string' || !description) return null;
  try {
    const parsed: unknown = JSON.parse(description);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Upstream @nocobase/plugin-ai indexes interrupt actionRequests by tool name, which overwrites earlier parallel calls
 * to the same tool and leaves them stuck in invokeStatus="init". Iterate actionRequests directly and key by toolCallId.
 */
export function toInterruptActionsFixed(interrupt?: InterruptPayload): Map<string, InterruptAction> {
  const result = new Map<string, InterruptAction>();
  const actionRequests = interrupt?.actionRequests ?? [];
  const reviewConfigs = interrupt?.reviewConfigs ?? [];
  if (!actionRequests.length) {
    return result;
  }

  const reviewConfigsMap = new Map<string, InterruptReviewConfig>();
  for (const config of reviewConfigs) {
    reviewConfigsMap.set(config.actionName, config);
  }

  for (let order = 0; order < actionRequests.length; order++) {
    const actionRequest = actionRequests[order];
    const payload = parseInterruptDescription(actionRequest.description);
    const matchingConfig =
      reviewConfigs[order]?.actionName === actionRequest.name
        ? reviewConfigs[order]
        : reviewConfigsMap.get(actionRequest.name);

    const toolCallId = payload ? readOptionalString(payload, 'toolCallId') : undefined;
    const toolCallName = payload ? readOptionalString(payload, 'toolCallName') : undefined;
    const sessionId = payload ? readOptionalString(payload, 'sessionId') : undefined;
    const from = payload ? readOptionalString(payload, 'from') : undefined;
    const username = payload ? readOptionalString(payload, 'username') : undefined;

    const toolCall =
      payload && toolCallId
        ? {
            id: toolCallId,
            name: toolCallName ?? actionRequest.name,
          }
        : undefined;

    const currentConversation =
      payload && sessionId
        ? {
            sessionId,
            from: from ?? '',
            username: username ?? '',
          }
        : undefined;

    const baseKey = toolCall?.id || `${actionRequest.name}:${order}`;
    const key = result.has(baseKey) ? `${baseKey}:${order}` : baseKey;

    result.set(key, {
      order,
      description: actionRequest.description,
      allowedDecisions: matchingConfig?.allowedDecisions,
      toolCall,
      currentConversation,
    });
  }

  return result;
}

export function installParallelInterruptActionsPatch(targetPrototype?: PatchableAIEmployeePrototype): () => void {
  const target = targetPrototype ?? (AIEmployee?.prototype as PatchableAIEmployeePrototype | undefined);
  if (!target || typeof target.toInterruptActions !== 'function') {
    return () => undefined;
  }

  const owner = Symbol('parallel-interrupt-actions-owner');
  let state = target[PATCH_STATE_KEY];
  if (state && target.toInterruptActions === state.wrapped) {
    state.owners.add(owner);
  } else {
    const original = target.toInterruptActions;
    const wrapped: ToInterruptActionsFn = function toInterruptActionsPatched(interrupt?: InterruptPayload) {
      return toInterruptActionsFixed(interrupt);
    };
    state = {
      original,
      wrapped,
      owners: new Set([owner]),
    };
    target[PATCH_STATE_KEY] = state;
    target.toInterruptActions = wrapped;
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const currentState = target[PATCH_STATE_KEY];
    if (!currentState) return;
    currentState.owners.delete(owner);
    if (currentState.owners.size === 0) {
      if (target.toInterruptActions === currentState.wrapped) {
        target.toInterruptActions = currentState.original;
      }
      delete target[PATCH_STATE_KEY];
    }
  };
}
