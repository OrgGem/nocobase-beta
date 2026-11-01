import { defaultTheme, useGlobalTheme } from '@nocobase/client-v2';
import { useFlowContext } from '@nocobase/flow-engine';
import { error } from '@nocobase/utils/client';
import React, { useEffect, useRef } from 'react';
import { LoginThemeProvider } from '../../client/components/LoginThemeProvider';
import {
  deserializeTheme,
  getEffectiveTheme,
  getUserThemeId,
  listThemes,
  normalizeTheme,
  serializeTheme,
} from '../themeApi';

export default function ThemeRuntime() {
  const ctx = useFlowContext();
  const { setTheme } = useGlobalTheme();
  const storageApplied = useRef(false);
  const userId = ctx.user?.id;
  const themeId = getUserThemeId(ctx.user);

  useEffect(() => {
    if (storageApplied.current) return;
    storageApplied.current = true;
    const cached = ctx.api.auth.getOption('theme');
    if (!cached) return;
    try {
      setTheme(normalizeTheme(deserializeTheme(JSON.parse(cached)).config, defaultTheme));
    } catch (err) {
      error(err);
    }
  }, [ctx.api.auth, setTheme]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const applyTheme = async () => {
      try {
        const items = await listThemes(ctx.api);
        if (cancelled) return;
        const selected = getEffectiveTheme(items, themeId);
        setTheme(normalizeTheme(selected?.config || null, defaultTheme));
        ctx.api.auth.setOption('theme', selected?.config ? serializeTheme(selected) : null);
      } catch (err) {
        error(err);
      }
    };
    applyTheme();
    return () => {
      cancelled = true;
    };
  }, [ctx.api, userId, themeId, setTheme]);

  return <LoginThemeProvider />;
}
