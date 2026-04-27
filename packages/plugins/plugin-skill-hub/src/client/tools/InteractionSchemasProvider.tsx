import React, { createContext, useContext, useEffect, useState } from 'react';
import { useAPIClient } from '@nocobase/client';
import { parseJsonText } from '../utils/jsonFields';

export type InteractionSchema = {
  type: 'form' | 'select' | 'confirm';
  prompt: string;
  options?: { label: string; value: string | number }[];
  fields?: Record<string, { type?: string; title?: string; required?: boolean; enum?: any[] }>;
};

const Ctx = createContext<Map<string, InteractionSchema>>(new Map());

export const useInteractionSchemas = () => useContext(Ctx);

const sanitize = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

export const InteractionSchemasProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const api = useAPIClient();
  const [map, setMap] = useState<Map<string, InteractionSchema>>(new Map());

  useEffect(() => {
    let cancelled = false;
    api
      .request({
        url: 'skillDefinitions:list',
        params: {
          filter: { enabled: true },
          fields: ['name', 'autoCall', 'interactionSchema'],
          pageSize: 200,
        },
      })
      .then(({ data }) => {
        if (cancelled) return;
        const next = new Map<string, InteractionSchema>();
        const list = data?.data ?? [];
        for (const s of list) {
          if (s.autoCall) continue;
          const schema = parseJsonText<InteractionSchema | null>(s.interactionSchema, null);
          if (!schema) continue;
          next.set(sanitize(s.name), schema);
        }
        setMap(next);
      })
      .catch(() => {
        // silently ignore — user may lack permission to list definitions
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return <Ctx.Provider value={map}>{children}</Ctx.Provider>;
};
