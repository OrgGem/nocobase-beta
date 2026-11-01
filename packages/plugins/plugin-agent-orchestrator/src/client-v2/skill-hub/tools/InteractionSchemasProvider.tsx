import { useApp, type ToolsManager } from '@nocobase/client-v2';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { loadInteractions, type SkillInteraction } from './interactions';
import { SkillHubCard } from './SkillHubCard';

const Context = createContext(new Map<string, SkillInteraction>());
const registered = new WeakMap<ToolsManager, Set<string>>();
export const useInteractions = () => useContext(Context);

export function registerSkillCard(manager: ToolsManager, name: string) {
  let names = registered.get(manager);
  if (!names) registered.set(manager, (names = new Set()));
  if (names.has(name)) return;
  manager.registerTools(name, { ui: { card: SkillHubCard } });
  names.add(name);
}

export function InteractionSchemasProvider({ children }: React.PropsWithChildren) {
  const app = useApp();
  const api = app.apiClient;
  const [token, setToken] = useState(() => api.auth.getToken());
  const [version, setVersion] = useState(0);
  const [interactions, setInteractions] = useState(new Map<string, SkillInteraction>());

  useEffect(() => {
    const refresh = () => setVersion((current) => current + 1);
    const authChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ token?: string | null }>).detail;
      setToken(detail && 'token' in detail ? detail.token || '' : api.auth.getToken());
      refresh();
    };
    window.addEventListener('skill-hub-loop-settings-changed', refresh);
    app.eventBus.addEventListener('auth:tokenChanged', authChanged);
    app.eventBus.addEventListener('auth:roleChanged', refresh);
    return () => {
      window.removeEventListener('skill-hub-loop-settings-changed', refresh);
      app.eventBus.removeEventListener('auth:tokenChanged', authChanged);
      app.eventBus.removeEventListener('auth:roleChanged', refresh);
    };
  }, [app, api.auth]);

  useEffect(() => {
    let cancelled = false;
    setInteractions(new Map());
    if (token) {
      loadInteractions(api)
        .then((next) => {
          if (cancelled) return;
          for (const interaction of next.values()) registerSkillCard(app.aiManager.toolsManager, interaction.toolName);
          setInteractions(next);
        })
        .catch(() => {
          // The generic review card remains available if this user cannot list skill definitions.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [app, api, token, version]);

  return <Context.Provider value={interactions}>{children}</Context.Provider>;
}
