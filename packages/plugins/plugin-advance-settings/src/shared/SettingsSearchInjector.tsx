// SPDX-License-Identifier: Apache-2.0

import { theme } from 'antd';
import React, { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';

const SETTINGS_SEARCH_ID = 'settings-sidebar-search';
const MENU_ITEM_SELECTOR = '.ant-menu-item, .ant-menu-submenu';
export const DEFAULT_SETTINGS_SEARCH_ICON = 'SearchOutlined';

export function resolveSettingsSearchIcon(rawIcon: unknown): string {
  if (rawIcon === null) {
    return '';
  }
  return typeof rawIcon === 'string' ? rawIcon : DEFAULT_SETTINGS_SEARCH_ICON;
}

export type SettingsSearchConfig = {
  enabled?: boolean;
  icon?: React.ReactNode;
};

export const SettingsSearchConfigContext = React.createContext<SettingsSearchConfig | undefined>(undefined);

/** Both client runtimes render the settings menu next to the settings page header. */
function findSettingsMenu(): HTMLElement | null {
  const sidebars = document.querySelectorAll<HTMLElement>('.ant-layout-sider');
  for (const sidebar of sidebars) {
    const content = sidebar.nextElementSibling;
    if (!content?.classList.contains('ant-layout-content')) continue;
    if (
      !Array.from(content.children).some(
        (child) =>
          child.classList.contains('ant-page-header') || child.classList.contains('ant-page-header-no-children'),
      )
    ) {
      continue;
    }

    const children = Array.from(sidebar.children).find((child) =>
      child.classList.contains('ant-layout-sider-children'),
    );
    const menu = Array.from(children?.children || []).find((child) => child.classList.contains('ant-menu'));
    if (menu instanceof HTMLElement) return menu;
  }
  return null;
}

type DisplayStyle = { value: string; priority: string };

/** Adds a search input to the settings menu without changing the host's components. */
export const SettingsSearchInjector: React.FC<React.PropsWithChildren<SettingsSearchConfig>> = ({
  children,
  enabled: enabledProp,
  icon: iconProp,
}) => {
  const context = useContext(SettingsSearchConfigContext);
  const enabled = enabledProp ?? context?.enabled ?? true;
  const resolvedIcon = iconProp !== undefined ? iconProp : context !== undefined ? context.icon : '🔍';
  const showIcon = resolvedIcon !== null && resolvedIcon !== undefined && resolvedIcon !== false && resolvedIcon !== '';
  const showIconRef = useRef(showIcon);
  showIconRef.current = showIcon;

  const { pathname } = useLocation();
  const { token } = theme.useToken();
  const { t } = useTranslation('plugin-advance-settings', { nsMode: 'fallback' });
  const placeholder = t('Search settings...');
  const label = t('Settings Search');
  const searchTermRef = useRef('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [iconSlot, setIconSlot] = useState<HTMLSpanElement | null>(null);
  const isSettingsPage = pathname === '/admin/settings' || pathname.startsWith('/admin/settings/');
  const { paddingSM, colorBorder, colorBgContainer, colorText, colorTextSecondary, colorPrimary } = token;

  useEffect(() => {
    if (!isSettingsPage || !enabled) {
      searchTermRef.current = '';
      inputRef.current = null;
      setIconSlot(null);
      return;
    }

    let menu: HTMLElement | null = null;
    let container: HTMLElement | null = null;
    const originalDisplay = new Map<HTMLElement, DisplayStyle>();

    const restoreDisplay = () => {
      originalDisplay.forEach(({ value, priority }, element) => {
        if (value) {
          element.style.setProperty('display', value, priority);
        } else {
          element.style.removeProperty('display');
        }
      });
      originalDisplay.clear();
    };

    const setVisible = (element: HTMLElement, visible: boolean) => {
      let original = originalDisplay.get(element);
      if (!original) {
        original = {
          value: element.style.getPropertyValue('display'),
          priority: element.style.getPropertyPriority('display'),
        };
        originalDisplay.set(element, original);
      }
      if (visible && !original.value) {
        element.style.removeProperty('display');
      } else {
        element.style.setProperty('display', visible ? original.value : 'none', original.priority);
      }
    };

    const filterMenuItems = () => {
      if (!menu) return;
      const term = searchTermRef.current.toLowerCase().trim();
      if (!term) {
        restoreDisplay();
        return;
      }

      menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR).forEach((item) => {
        const itemLabel = item.textContent?.toLowerCase() || '';
        const title = item.getAttribute('title')?.toLowerCase() || '';
        setVisible(item, itemLabel.includes(term) || title.includes(term));
      });

      menu.querySelectorAll<HTMLElement>('.ant-menu-item-divider').forEach((divider) => {
        const previous = divider.previousElementSibling;
        const next = divider.nextElementSibling;
        const previousHidden = !(previous instanceof HTMLElement) || previous.style.display === 'none';
        const nextHidden = !(next instanceof HTMLElement) || next.style.display === 'none';
        setVisible(divider, !(previousHidden && nextHidden));
      });
    };

    const createSearchBox = () => {
      const box = document.createElement('search');
      box.id = SETTINGS_SEARCH_ID;
      box.style.padding = `${paddingSM}px ${paddingSM}px 0`;
      box.style.boxSizing = 'border-box';

      const wrapper = document.createElement('div');
      wrapper.style.position = 'relative';

      const input = document.createElement('input');
      input.type = 'search';
      input.placeholder = placeholder;
      input.setAttribute('aria-label', label);
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('autocapitalize', 'none');
      input.spellcheck = false;
      input.value = searchTermRef.current;
      input.style.cssText = [
        'width: 100%',
        showIconRef.current ? 'padding: 4px 28px 4px 8px' : 'padding: 4px 8px',
        'border: 1px solid',
        'border-radius: 6px',
        'outline: none',
        'font-size: 14px',
        'box-sizing: border-box',
      ].join(';');
      input.style.borderColor = colorBorder;
      input.style.background = colorBgContainer;
      input.style.color = colorText;
      input.addEventListener('focus', () => {
        input.style.borderColor = colorPrimary;
        input.style.outline = `2px solid ${colorPrimary}`;
        input.style.outlineOffset = '-1px';
      });
      input.addEventListener('blur', () => {
        input.style.borderColor = colorBorder;
        input.style.outline = 'none';
        input.style.outlineOffset = '';
      });
      input.addEventListener('input', () => {
        searchTermRef.current = input.value;
        filterMenuItems();
      });
      inputRef.current = input;
      wrapper.appendChild(input);

      const icon = document.createElement('span');
      icon.dataset.testid = 'settings-search-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.style.cssText = [
        'position: absolute',
        'right: 8px',
        'top: 50%',
        'transform: translateY(-50%)',
        'pointer-events: none',
        'font-size: 14px',
        'line-height: 1',
        'align-items: center',
      ].join(';');
      icon.style.color = colorTextSecondary || colorText;
      icon.style.display = showIconRef.current ? 'inline-flex' : 'none';
      wrapper.appendChild(icon);
      box.appendChild(wrapper);
      setIconSlot(icon);
      return box;
    };

    const reconcile = (mutations: MutationRecord[] = []) => {
      const nextMenu = findSettingsMenu();
      const menuChanged = nextMenu !== menu;
      if (menuChanged) {
        restoreDisplay();
        container?.remove();
        container = null;
        inputRef.current = null;
        menu = nextMenu;
        if (!nextMenu) {
          setIconSlot(null);
        }
      }
      const currentMenu = menu;
      if (!currentMenu?.parentElement) return;

      if (!container) container = createSearchBox();
      if (container.parentElement !== currentMenu.parentElement || container.nextElementSibling !== currentMenu) {
        currentMenu.parentElement.insertBefore(container, currentMenu);
      }
      if (
        searchTermRef.current &&
        (menuChanged || mutations.some((mutation) => currentMenu.contains(mutation.target)))
      ) {
        filterMenuItems();
      }
    };

    reconcile();
    if (!menu) {
      setIconSlot(null);
    }
    const observer = new MutationObserver(reconcile);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      restoreDisplay();
      container?.remove();
      inputRef.current = null;
    };
  }, [
    enabled,
    isSettingsPage,
    paddingSM,
    colorBorder,
    colorBgContainer,
    colorText,
    colorTextSecondary,
    colorPrimary,
    placeholder,
    label,
  ]);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.padding = showIcon ? '4px 28px 4px 8px' : '4px 8px';
    }
    if (iconSlot) {
      iconSlot.style.display = showIcon ? 'inline-flex' : 'none';
    }
  }, [iconSlot, showIcon]);

  return (
    <>
      {children}
      {isSettingsPage && enabled && iconSlot && showIcon ? createPortal(resolvedIcon, iconSlot) : null}
    </>
  );
};
