// SPDX-License-Identifier: Apache-2.0

import type { Application } from '@nocobase/client-v2';
import { getGlobalChatBoxRuntime, type ChatBoxRuntime } from '@nocobase/plugin-ai/client-v2';

export interface ChatScope {
  root: HTMLElement;
  runtime: ChatBoxRuntime;
}

/** Find mounted AI chat boxes using the refs owned by their individual runtimes. */
export function getChatScopes(app: Pick<Application, 'flowEngine'>): ChatScope[] {
  const scopes: ChatScope[] = [];
  const addRuntime = (runtime: ChatBoxRuntime | undefined) => {
    const root = runtime?.chatBoxModel?.chatBoxRef?.current;
    if (runtime && root && !scopes.some((scope) => scope.root === root)) {
      scopes.push({ root, runtime });
    }
  };

  addRuntime(getGlobalChatBoxRuntime());
  let engine: Application['flowEngine'] | undefined = app.flowEngine;
  while (engine?.previousEngine) engine = engine.previousEngine;
  while (engine) {
    engine.forEachModel((model) => {
      if ('chatBoxRuntime' in model) {
        addRuntime(model.chatBoxRuntime as ChatBoxRuntime | undefined);
      }
    });
    engine = engine.nextEngine;
  }
  return scopes;
}

export function getChatScope(app: Pick<Application, 'flowEngine'>, target: Element): ChatScope | undefined {
  return getChatScopes(app).reduce<ChatScope | undefined>((closest, scope) => {
    if (!scope.root.contains(target)) return closest;
    return !closest || closest.root.contains(scope.root) ? scope : closest;
  }, undefined);
}
