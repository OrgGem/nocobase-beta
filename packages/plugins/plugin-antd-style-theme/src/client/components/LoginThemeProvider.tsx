/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useGlobalTheme } from '@nocobase/client-v2';
import type { CustomToken } from '@nocobase/client-v2';
import React, { useEffect, useRef, useState } from 'react';
import { useInRouterContext, useLocation } from 'react-router-dom';
import type { LoginThemeTokens } from '../../types';

/**
 * LoginThemeProvider injects CSS styles into the login page
 * based on login-related custom tokens stored in theme.token.
 *
 * Uses a MutationObserver on <head> only while on auth pages so our style tag
 * stays the LAST element without adding overhead on admin pages.
 */
const LOGIN_STYLE_ID = 'antd-style-theme-login-css';
const RASTER_DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const DANGEROUS_CSS_RE = /[{};\\<>]|\/\*|\*\/|@import|expression\s*\(|url\s*\(|javascript:/i;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function sanitizeSafeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || hasControlChars(raw)) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return trimmed;
  }
  if (RASTER_DATA_IMAGE_RE.test(trimmed)) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}

export function sanitizeCssValue(raw: unknown): string | null {
  if (typeof raw !== 'string' || hasControlChars(raw)) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 500) {
    return null;
  }
  if (DANGEROUS_CSS_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function toSafePx(raw: unknown, allowZero = false): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw > 4000) {
    return null;
  }
  if (allowZero ? raw < 0 : raw <= 0) {
    return null;
  }
  return raw;
}

function ensureStyleIsLast() {
  const styleEl = document.getElementById(LOGIN_STYLE_ID);
  if (styleEl && styleEl.nextSibling) {
    document.head.appendChild(styleEl);
  }
}

const RouterPathnameWatcher: React.FC<{ onChange: (pathname: string) => void }> = ({ onChange }) => {
  const { pathname } = useLocation();
  useEffect(() => {
    onChange(pathname);
  }, [onChange, pathname]);
  return null;
};

const FallbackPathnameWatcher: React.FC<{ onChange: (pathname: string) => void }> = ({ onChange }) => {
  useEffect(() => {
    const sync = () => {
      onChange(window.location.pathname);
    };
    sync();
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, [onChange]);
  return null;
};

const LoginThemeInjector: React.FC = () => {
  const { theme } = useGlobalTheme();
  const inRouter = useInRouterContext();
  const [pathname, setPathname] = useState<string>(() =>
    typeof window !== 'undefined' ? window.location.pathname : '',
  );
  const observerRef = useRef<MutationObserver | null>(null);
  const initialTitleRef = useRef<string | null>(null);
  const initialFaviconRef = useRef<{ href: string | null; created: boolean } | null>(null);

  useEffect(() => {
    const token = (theme?.token || {}) as Partial<CustomToken> & LoginThemeTokens;

    const faviconUrl = sanitizeSafeUrl(token.appFavicon);
    if (faviconUrl) {
      let link = document.querySelector<HTMLLinkElement>('link[rel="shortcut icon"]');
      let created = false;
      if (!link) {
        link = document.createElement('link');
        link.rel = 'shortcut icon';
        document.head.appendChild(link);
        created = true;
      }
      if (!initialFaviconRef.current) {
        initialFaviconRef.current = {
          href: created ? null : link.getAttribute('href'),
          created,
        };
      }
      link.href = faviconUrl;
    } else if (initialFaviconRef.current) {
      const link = document.querySelector<HTMLLinkElement>('link[rel="shortcut icon"]');
      if (link) {
        if (initialFaviconRef.current.created) {
          link.remove();
        } else if (initialFaviconRef.current.href !== null) {
          link.href = initialFaviconRef.current.href;
        } else {
          link.removeAttribute('href');
        }
      }
      initialFaviconRef.current = null;
    }

    const appTitle = typeof token.appTitle === 'string' ? token.appTitle.trim() : '';
    if (appTitle) {
      if (initialTitleRef.current === null) {
        initialTitleRef.current = document.title;
      }
      document.title = appTitle;
    } else if (initialTitleRef.current !== null) {
      document.title = initialTitleRef.current;
      initialTitleRef.current = null;
    }

    const isLoginPage = pathname.includes('/signin') || pathname.includes('/signup') || pathname.includes('/sign-in');
    const rules: string[] = [];

    if (isLoginPage) {
      const bgColor = sanitizeCssValue(token.loginBgColor);
      const bgImage = sanitizeSafeUrl(token.loginBgImage);
      const bgGradient = sanitizeCssValue(token.loginBgGradient);

      if (bgColor || bgImage || bgGradient) {
        const bgProps: string[] = [];
        if (bgGradient) {
          bgProps.push(`background: ${bgGradient} !important;`);
        } else if (bgColor) {
          bgProps.push(`background-color: ${bgColor} !important;`);
        }
        if (bgImage) {
          bgProps.push(`background-image: url(${JSON.stringify(bgImage)}) !important;`);
          bgProps.push('background-size: cover !important;');
          bgProps.push('background-position: center !important;');
          bgProps.push('background-repeat: no-repeat !important;');
        }
        bgProps.push('min-height: 100vh !important;');

        rules.push(`
          body.nb-login-themed {
            ${bgProps.join('\n            ')}
          }
          body.nb-login-themed #root,
          body.nb-login-themed .ant-app {
            min-height: 100vh !important;
            height: 100vh !important;
            background: transparent !important;
            background-color: transparent !important;
          }
          body.nb-login-themed .ant-app div:not(.ant-input):not(.ant-input-wrapper):not(.ant-input-affix-wrapper):not(.ant-btn):not(.ant-formily-item-control):not([class*="ant-select"]) {
            background-color: transparent !important;
          }
        `);
      }

      const cardBg = sanitizeCssValue(token.loginCardBg);
      const cardRadius = toSafePx(token.loginCardBorderRadius, true);
      const cardShadow = sanitizeCssValue(token.loginCardShadow);
      const cardWidth = toSafePx(token.loginCardWidth);

      if (cardBg || cardRadius !== null || cardShadow || cardWidth !== null) {
        const cardProps: string[] = [];
        if (cardBg) cardProps.push(`background-color: ${cardBg} !important;`);
        if (cardRadius !== null) cardProps.push(`border-radius: ${cardRadius}px;`);
        if (cardShadow) cardProps.push(`box-shadow: ${cardShadow};`);
        if (cardWidth !== null) cardProps.push(`max-width: ${cardWidth}px !important; width: 100% !important;`);
        cardProps.push('padding: 32px !important;');

        rules.push(`
          body.nb-login-themed .ant-app > div > div > div[style*="max-width"] {
            ${cardProps.join('\n            ')}
          }
        `);
      }

      const btnBg = sanitizeCssValue(token.loginBtnBg);
      const btnRadius = toSafePx(token.loginBtnBorderRadius, true);

      if (btnBg || btnRadius !== null) {
        const btnProps: string[] = [];
        if (btnBg) btnProps.push(`background-color: ${btnBg} !important; border-color: ${btnBg} !important;`);
        if (btnRadius !== null) btnProps.push(`border-radius: ${btnRadius}px !important;`);
        rules.push(`
          body.nb-login-themed .ant-btn-primary {
            ${btnProps.join('\n            ')}
          }
        `);
      }

      const logoUrl = sanitizeSafeUrl(token.loginLogoUrl);
      const logoHeight = toSafePx(token.loginLogoHeight) ?? 40;

      if (logoUrl) {
        rules.push(`
          body.nb-login-themed .nb-brand {
            background-image: url(${JSON.stringify(logoUrl)}) !important;
            background-repeat: no-repeat !important;
            background-position: center !important;
            background-size: contain !important;
            height: ${logoHeight}px !important;
            overflow: hidden !important;
          }
          body.nb-login-themed .nb-brand * {
            visibility: hidden !important;
          }
        `);
      }
    }

    const rulesText = rules.join('\n').trim();
    const existingStyleEl = document.getElementById(LOGIN_STYLE_ID) as HTMLStyleElement | null;

    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    if (isLoginPage && rulesText) {
      const styleEl = existingStyleEl || document.createElement('style');
      styleEl.id = LOGIN_STYLE_ID;
      styleEl.textContent = rulesText;
      document.head.appendChild(styleEl);
      document.body.classList.add('nb-login-themed');

      observerRef.current = new MutationObserver(() => {
        ensureStyleIsLast();
      });
      observerRef.current.observe(document.head, { childList: true });
    } else {
      if (existingStyleEl) {
        existingStyleEl.remove();
      }
      document.body.classList.remove('nb-login-themed');
    }

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
      document.body.classList.remove('nb-login-themed');
    };
  }, [pathname, theme]);

  useEffect(() => {
    return () => {
      const el = document.getElementById(LOGIN_STYLE_ID);
      if (el) el.remove();
      document.body.classList.remove('nb-login-themed');
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
    };
  }, []);

  return inRouter ? (
    <RouterPathnameWatcher onChange={setPathname} />
  ) : (
    <FallbackPathnameWatcher onChange={setPathname} />
  );
};

export const LoginThemeProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  return (
    <>
      <LoginThemeInjector />
      {children}
    </>
  );
};

export default LoginThemeProvider;
