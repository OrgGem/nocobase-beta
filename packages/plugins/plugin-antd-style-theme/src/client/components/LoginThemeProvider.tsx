/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useGlobalTheme } from '@nocobase/client-v2';
import React, { useEffect, useRef } from 'react';

/**
 * LoginThemeProvider injects CSS styles into the login page
 * based on login-related custom tokens stored in theme.token.
 *
 * Uses a MutationObserver on <head> to ensure our style tag
 * is always the LAST element — this prevents Antd CSS-in-JS
 * from overriding our login page styles.
 */
const LOGIN_STYLE_ID = 'antd-style-theme-login-css';

/**
 * Ensure our style tag is the last child of <head>.
 * Antd's CSS-in-JS (emotion) injects styles dynamically,
 * and later styles override earlier ones.
 */
function ensureStyleIsLast() {
  const styleEl = document.getElementById(LOGIN_STYLE_ID);
  if (styleEl && styleEl.nextSibling) {
    document.head.appendChild(styleEl);
  }
}

const LoginThemeInjector: React.FC = () => {
  const { theme } = useGlobalTheme();
  const observerRef = useRef<MutationObserver | null>(null);
  const intervalRef = useRef<any>(null);

  useEffect(() => {
    const token = (theme?.token as any) || {};

    // Apply app favicon
    const faviconUrl = token.appFavicon;
    if (faviconUrl) {
      let link: HTMLLinkElement = document.querySelector('link[rel="shortcut icon"]');
      if (!link) {
        link = document.createElement('link');
        link.rel = 'shortcut icon';
        document.head.appendChild(link);
      }
      link.href = faviconUrl;
    }

    // Apply app title
    const appTitle = token.appTitle;
    if (appTitle) {
      document.title = appTitle;
    }

    const rules: string[] = [];

    const bgColor = token.loginBgColor;
    const bgImage = token.loginBgImage;
    const bgGradient = token.loginBgGradient;

    if (bgColor || bgImage || bgGradient) {
      const bgProps: string[] = [];
      if (bgGradient) {
        bgProps.push(`background: ${bgGradient} !important;`);
      } else if (bgColor) {
        bgProps.push(`background-color: ${bgColor} !important;`);
      }
      if (bgImage) {
        bgProps.push(`background-image: url(${bgImage}) !important;`);
        bgProps.push(`background-size: cover !important;`);
        bgProps.push(`background-position: center !important;`);
        bgProps.push(`background-repeat: no-repeat !important;`);
      }
      bgProps.push('min-height: 100vh !important;');

      rules.push(`
        body.nb-login-themed {
          ${bgProps.join('\n          ')}
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

    // Login card / form wrapper styling
    const cardBg = token.loginCardBg;
    const cardRadius = token.loginCardBorderRadius;
    const cardShadow = token.loginCardShadow;
    const cardWidth = token.loginCardWidth;

    if (cardBg || cardRadius || cardShadow || cardWidth) {
      const cardProps: string[] = [];
      if (cardBg) cardProps.push(`background-color: ${cardBg} !important;`);
      if (cardRadius) cardProps.push(`border-radius: ${cardRadius}px;`);
      if (cardShadow) cardProps.push(`box-shadow: ${cardShadow};`);
      if (cardWidth) cardProps.push(`max-width: ${cardWidth}px !important; width: 100% !important;`);
      cardProps.push('padding: 32px !important;');

      rules.push(`
        body.nb-login-themed .ant-app > div > div > div[style*="max-width"] {
          ${cardProps.join('\n          ')}
        }
      `);
    }

    // Login button styling
    const btnBg = token.loginBtnBg;
    const btnRadius = token.loginBtnBorderRadius;

    if (btnBg || btnRadius) {
      const btnProps: string[] = [];
      if (btnBg) btnProps.push(`background-color: ${btnBg} !important; border-color: ${btnBg} !important;`);
      if (btnRadius) btnProps.push(`border-radius: ${btnRadius}px !important;`);
      rules.push(`
        body.nb-login-themed .ant-btn-primary {
          ${btnProps.join('\n          ')}
        }
      `);
    }

    // Login logo
    const logoUrl = token.loginLogoUrl;
    const logoHeight = token.loginLogoHeight;

    if (logoUrl) {
      rules.push(`
        body.nb-login-themed .nb-brand {
          background-image: url(${logoUrl}) !important;
          background-repeat: no-repeat !important;
          background-position: center !important;
          background-size: contain !important;
          height: ${logoHeight || 40}px !important;
          overflow: hidden !important;
        }
        body.nb-login-themed .nb-brand * {
          visibility: hidden !important;
        }
      `);
    }

    const rulesText = rules.join('\n');

    // Inject or update style tag — always place it LAST in <head>
    let styleEl = document.getElementById(LOGIN_STYLE_ID) as HTMLStyleElement;
    if (rulesText.trim()) {
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = LOGIN_STYLE_ID;
      }
      styleEl.textContent = rulesText;
      // Always append (moves it to the end if already in DOM)
      document.head.appendChild(styleEl);
    } else if (styleEl) {
      styleEl.remove();
    }

    // Watch <head> for new style insertions (Antd CSS-in-JS)
    // and re-position our tag to the end whenever that happens
    if (observerRef.current) {
      observerRef.current.disconnect();
    }
    if (rulesText.trim()) {
      observerRef.current = new MutationObserver(() => {
        ensureStyleIsLast();
      });
      observerRef.current.observe(document.head, { childList: true });
    }

    // Route detection — add/remove body class
    const updateBodyClass = () => {
      const path = window.location.pathname;
      const isLoginPage = path.includes('/signin') || path.includes('/signup') || path.includes('/sign-in');
      if (isLoginPage && rulesText.trim()) {
        document.body.classList.add('nb-login-themed');
      } else {
        document.body.classList.remove('nb-login-themed');
      }
    };

    updateBodyClass();
    window.addEventListener('popstate', updateBodyClass);
    intervalRef.current = setInterval(updateBodyClass, 1000);

    return () => {
      window.removeEventListener('popstate', updateBodyClass);
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (observerRef.current) observerRef.current.disconnect();
      document.body.classList.remove('nb-login-themed');
    };
  }, [theme]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const el = document.getElementById(LOGIN_STYLE_ID);
      if (el) el.remove();
      document.body.classList.remove('nb-login-themed');
      if (observerRef.current) observerRef.current.disconnect();
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return null;
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
