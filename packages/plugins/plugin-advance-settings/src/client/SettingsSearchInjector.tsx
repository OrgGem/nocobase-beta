import { theme } from 'antd';
import React, { useCallback, useEffect, useRef } from 'react';

const SETTINGS_SEARCH_ID = 'settings-sidebar-search';
const MENU_ITEM_SELECTOR = '.ant-menu-item, .ant-menu-submenu';

/**
 * Global component injected via app.use() that watches for the Settings sidebar
 * and injects a search input above the menu. Uses MutationObserver to handle
 * dynamic rendering and route changes without modifying core components.
 *
 * This component is used as an application-level provider, so it must render
 * props.children to keep the app tree intact. It must not rely on router
 * context (providers live outside the Router) and must not hold React state
 * that would re-render the whole app tree while typing. The search term is
 * kept in a ref and filtering is applied directly on the DOM.
 */
export const SettingsSearchInjector: React.FC<React.PropsWithChildren<{}>> = (props) => {
  const { token } = theme.useToken();
  const searchTermRef = useRef('');
  const observerRef = useRef<MutationObserver | null>(null);
  const siderRef = useRef<HTMLElement | null>(null);

  const isSettingsPage = window.location.pathname.startsWith('/admin/settings');

  const filterMenuItems = useCallback((term: string) => {
    const sider = siderRef.current;
    if (!sider) return;

    const menuItems = sider.querySelectorAll(MENU_ITEM_SELECTOR);
    const normalizedTerm = term.toLowerCase().trim();

    menuItems.forEach((item) => {
      const htmlItem = item as HTMLElement;
      if (htmlItem.classList.contains('ant-menu-item-divider')) return;

      const label = htmlItem.textContent?.toLowerCase() || '';
      const title = htmlItem.getAttribute('title')?.toLowerCase() || '';
      const matches = !normalizedTerm || label.includes(normalizedTerm) || title.includes(normalizedTerm);

      htmlItem.style.display = matches ? '' : 'none';
    });

    const dividers = sider.querySelectorAll('.ant-menu-item-divider');
    dividers.forEach((divider) => {
      const htmlDivider = divider as HTMLElement;
      const prev = htmlDivider.previousElementSibling as HTMLElement;
      const next = htmlDivider.nextElementSibling as HTMLElement;
      const prevHidden = !prev || prev.style.display === 'none';
      const nextHidden = !next || next.style.display === 'none';
      htmlDivider.style.display = prevHidden && nextHidden ? 'none' : '';
    });
  }, []);

  const injectSearchBox = useCallback(() => {
    if (document.getElementById(SETTINGS_SEARCH_ID)) return;

    const sider = document.querySelector<HTMLElement>('.ant-layout-sider');
    if (!sider) return;

    // The menu may be nested inside .ant-layout-sider-children; insert before
    // the menu's actual parent to avoid NotFoundError on insertBefore.
    const menu = sider.querySelector<HTMLElement>('.ant-menu');
    if (!menu) return;
    const menuParent = menu.parentElement;
    if (!menuParent) return;
    if (!menuParent.contains(menu) || !sider.contains(menuParent)) return;

    const container = document.createElement('div');
    container.id = SETTINGS_SEARCH_ID;
    container.style.padding = `${token.paddingSM}px ${token.paddingSM}px 0`;
    container.style.boxSizing = 'border-box';

    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Search settings...';
    input.setAttribute('aria-label', 'Search settings');
    input.style.cssText = [
      'width: 100%',
      'padding: 4px 28px 4px 8px',
      'border: 1px solid',
      'border-radius: 6px',
      'outline: none',
      'font-size: 14px',
      'box-sizing: border-box',
    ].join(';');
    // Colors are applied on first injection (token values are stable for the session)
    input.style.borderColor = token.colorBorder;
    input.style.background = token.colorBgContainer;
    input.style.color = token.colorText;

    input.addEventListener('focus', () => {
      input.style.borderColor = token.colorPrimary;
    });
    input.addEventListener('blur', () => {
      input.style.borderColor = token.colorBorder;
    });
    input.addEventListener('input', (e) => {
      const value = (e.target as HTMLInputElement).value;
      searchTermRef.current = value;
      filterMenuItems(value);
    });

    wrapper.appendChild(input);

    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.style.cssText = [
      'position: absolute',
      'right: 8px',
      'top: 50%',
      'transform: translateY(-50%)',
      'pointer-events: none',
      'font-size: 14px',
    ].join(';');
    icon.textContent = '🔍';
    wrapper.appendChild(icon);

    container.appendChild(wrapper);
    menuParent.insertBefore(container, menu);
    siderRef.current = sider;
  }, [token, filterMenuItems]);

  const removeSearchBox = useCallback(() => {
    const existing = document.getElementById(SETTINGS_SEARCH_ID);
    if (existing) {
      existing.remove();
    }
    siderRef.current = null;
    searchTermRef.current = '';
  }, []);

  useEffect(() => {
    if (!isSettingsPage) {
      removeSearchBox();
      return;
    }

    // Try to inject immediately
    injectSearchBox();

    // Set up MutationObserver to re-inject when React replaces the sidebar.
    // The observer callback only injects when the search box is missing; it
    // never re-renders React state, so it cannot loop or crash the app.
    const observer = new MutationObserver(() => {
      if (document.getElementById(SETTINGS_SEARCH_ID)) {
        return;
      }
      try {
        injectSearchBox();
      } catch (err) {
        console.error('[SettingsSearch] inject failed:', err);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    observerRef.current = observer;

    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [isSettingsPage, injectSearchBox, removeSearchBox]);

  // Track route changes globally so the search box lifecycle follows /admin/settings
  useEffect(() => {
    const handlePopState = () => {
      const onSettings = window.location.pathname.startsWith('/admin/settings');
      if (!onSettings) {
        removeSearchBox();
      } else {
        injectSearchBox();
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [injectSearchBox, removeSearchBox]);

  return <>{props.children}</>;
};
