// SPDX-License-Identifier: Apache-2.0

import { defaultTheme, useGlobalTheme } from '@nocobase/client-v2';
import { useFlowContext } from '@nocobase/flow-engine';
import { error } from '@nocobase/utils/client';
import React, { useEffect, useRef } from 'react';
import { LoginThemeProvider } from '../../client/components/LoginThemeProvider';
import {
  ANTD_STYLE_THEME_REFRESH_EVENT,
  deserializeTheme,
  getEffectiveTheme,
  getUserThemeId,
  listThemes,
  normalizeTheme,
  serializeTheme,
  THEME_STORAGE_KEY,
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
    const cached = ctx.api.auth.getOption(THEME_STORAGE_KEY);
    if (!cached) return;
    try {
      setTheme(normalizeTheme(deserializeTheme(JSON.parse(cached)).config, defaultTheme));
    } catch (err) {
      error(err);
    }
  }, [ctx.api.auth, setTheme]);

  useEffect(() => {
    let cancelled = false;
    const applyTheme = async () => {
      try {
        const items = await listThemes(ctx.api);
        if (cancelled) return;
        const selected = getEffectiveTheme(items, themeId);
        setTheme(normalizeTheme(selected?.config || null, defaultTheme));
        ctx.api.auth.setOption(THEME_STORAGE_KEY, selected?.config ? serializeTheme(selected) : null);
      } catch (err) {
        error(err);
      }
    };
    const handleRefresh = () => {
      applyTheme();
    };
    applyTheme();
    window.addEventListener(ANTD_STYLE_THEME_REFRESH_EVENT, handleRefresh);
    return () => {
      cancelled = true;
      window.removeEventListener(ANTD_STYLE_THEME_REFRESH_EVENT, handleRefresh);
    };
  }, [ctx.api, userId, themeId, setTheme]);

  return <LoginThemeProvider />;
}
