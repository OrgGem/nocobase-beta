// SPDX-License-Identifier: Apache-2.0

import type { Application } from '@nocobase/client-v2';
import { getGlobalChatBoxRuntime, type ChatBoxRuntime } from '@nocobase/plugin-ai/client-v2';

export interface ChatScope {
  root: HTMLElement;
  runtime: ChatBoxRuntime;
}

interface RawScope {
  coreRoot: HTMLElement;
  runtime: ChatBoxRuntime;
}

/**
 * In AIChatBoxView (chat block mode), chatBoxRef sits on the inner AIChatBoxCoreView div,
 * while the Messages history SidePanel (when `Show messages` is off) is mounted as a sibling
 * inside the block's outer Ant Design Layout. Expand the scope root to that outer block Layout
 * only when it wraps this chat block's `.ai-chat-box-header` and does not enclose another runtime.
 */
function resolveBlockScopeRoot(coreRoot: HTMLElement, allCoreRoots: HTMLElement[]): HTMLElement {
  let cursor: HTMLElement | null = coreRoot.closest('.ant-layout');
  let depth = 0;

  while (cursor && depth < 6) {
    const hasChatBlockHeader = Array.from(cursor.children).some((child) =>
      child.classList.contains('ai-chat-box-header'),
    );
    if (hasChatBlockHeader) {
      const outerLayout = cursor.parentElement;
      if (outerLayout instanceof HTMLElement && outerLayout.classList.contains('ant-layout')) {
        const enclosesAnotherChat = allCoreRoots.some(
          (otherRoot) => otherRoot !== coreRoot && outerLayout.contains(otherRoot),
        );
        if (!enclosesAnotherChat) {
          return outerLayout;
        }
      }
      break;
    }
    cursor = cursor.parentElement?.closest('.ant-layout') || null;
    depth += 1;
  }

  return coreRoot;
}

/** Find mounted AI chat boxes (global chat, chat blocks, and their Messages side panels). */
export function getChatScopes(app: Pick<Application, 'flowEngine'>): ChatScope[] {
  const rawScopes: RawScope[] = [];
  const addRuntime = (runtime: ChatBoxRuntime | undefined) => {
    const coreRoot = runtime?.chatBoxModel?.chatBoxRef?.current;
    if (runtime && coreRoot && !rawScopes.some((scope) => scope.coreRoot === coreRoot)) {
      rawScopes.push({ coreRoot, runtime });
    }
  };

  try {
    addRuntime(getGlobalChatBoxRuntime());
  } catch {
    // Global runtime may not be initialized in isolated test harnesses.
  }

  let engine: Application['flowEngine'] | undefined = app?.flowEngine;
  while (engine?.previousEngine) engine = engine.previousEngine;
  while (engine) {
    engine.forEachModel((model) => {
      if ('chatBoxRuntime' in model) {
        addRuntime(model.chatBoxRuntime as ChatBoxRuntime | undefined);
      }
    });
    engine = engine.nextEngine;
  }

  const allCoreRoots = rawScopes.map((item) => item.coreRoot);
  const scopes: ChatScope[] = [];
  for (const { coreRoot, runtime } of rawScopes) {
    const root = resolveBlockScopeRoot(coreRoot, allCoreRoots);
    if (!scopes.some((scope) => scope.root === root)) {
      scopes.push({ root, runtime });
    }
  }
  return scopes;
}

export function getChatScope(app: Pick<Application, 'flowEngine'>, target: Element): ChatScope | undefined {
  return getChatScopes(app).reduce<ChatScope | undefined>((closest, scope) => {
    if (!scope.root.contains(target)) return closest;
    return !closest || closest.root.contains(scope.root) ? scope : closest;
  }, undefined);
}
