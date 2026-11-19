/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import { useApp } from '@nocobase/client-v2';
import { parseJsonText } from '../utils/jsonFields';
import { InteractionSchema } from './loopTemplates';

const Ctx = createContext<Map<string, InteractionSchema>>(new Map());

export const useInteractionSchemas = () => useContext(Ctx);

type ApiClientWithAuth = ReturnType<typeof useApp>['apiClient'] & {
  auth?: {
    getToken?: () => string | null | undefined;
    token?: string | null;
  };
  app?: {
    eventBus?: {
      addEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
      removeEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
    };
  };
};

const sanitize = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

export const InteractionSchemasProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const api = useApp().apiClient as ApiClientWithAuth;
  const authToken = api.auth?.getToken?.() || api.auth?.token || '';
  const [map, setMap] = useState<Map<string, InteractionSchema>>(new Map());
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const refresh = () => setVersion((current) => current + 1);
    const refreshAfterSignIn = (event: Event) => {
      const token = (event as CustomEvent<{ token?: string | null }>).detail?.token;
      if (token) {
        refresh();
      }
    };
    window.addEventListener('skill-hub-loop-settings-changed', refresh);
    api.app?.eventBus?.addEventListener?.('auth:tokenChanged', refreshAfterSignIn);
    return () => {
      window.removeEventListener('skill-hub-loop-settings-changed', refresh);
      api.app?.eventBus?.removeEventListener?.('auth:tokenChanged', refreshAfterSignIn);
    };
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    if (!authToken) {
      return () => {
        cancelled = true;
      };
    }
    const extractList = (data: any) => {
      const value = data?.data?.data ?? data?.data ?? data ?? [];
      return Array.isArray(value) ? value : [];
    };
    const schemaFromLoopConfig = (config: any): InteractionSchema | null => {
      const schema = parseJsonText<InteractionSchema | null>(config.schema, null);
      if (schema && typeof schema === 'object') {
        return config.prompt && !schema.prompt ? { ...schema, prompt: config.prompt } : schema;
      }
      if (config.prompt) {
        return {
          type: 'confirm',
          prompt: config.prompt,
        };
      }
      return null;
    };

    Promise.all([
      api.request({
        url: 'skillDefinitions:list',
        skipNotify: true,
        params: {
          filter: { enabled: true },
          fields: ['id', 'name', 'toolName', 'autoCall', 'interactionSchema'],
          pageSize: 500,
        },
      }),
      api
        .request({
          url: 'skillLoopConfigs:list',
          skipNotify: true,
          params: {
            filter: { enabled: true },
            fields: ['skillId', 'enabled', 'schema', 'prompt', 'templateKey'],
            sort: ['-updatedAt'],
            pageSize: 500,
          },
        })
        .catch(() => ({ data: [] })),
    ])
      .then(([skillsResponse, loopConfigsResponse]) => {
        if (cancelled) return;
        const next = new Map<string, InteractionSchema>();
        const skills = extractList(skillsResponse.data);
        const loopConfigs = extractList(loopConfigsResponse.data);
        const skillsById = new Map(skills.map((skill: any) => [String(skill.id), skill]));

        for (const s of skills) {
          const schema = parseJsonText<InteractionSchema | null>(s.interactionSchema, null);
          if (!schema) continue;
          next.set(`skill:${s.name}`, schema);
          next.set(`tool:${s.toolName?.trim() || `skill_hub_${sanitize(s.name)}`}`, schema);
        }

        const seenSkillIds = new Set<string>();
        for (const config of loopConfigs) {
          const skillId = String(config.skillId);
          if (seenSkillIds.has(skillId)) continue;
          seenSkillIds.add(skillId);
          const skill = skillsById.get(skillId);
          if (!skill?.name) continue;
          const schema = schemaFromLoopConfig(config);
          if (!schema) continue;
          next.set(`skill:${skill.name}`, schema);
          next.set(`tool:${skill.toolName?.trim() || `skill_hub_${sanitize(skill.name)}`}`, schema);
        }

        setMap(next);
      })
      .catch(() => {
        // silently ignore — user may lack permission to list definitions
      });
    return () => {
      cancelled = true;
    };
  }, [api, authToken, version]);

  return <Ctx.Provider value={map}>{children}</Ctx.Provider>;
};
