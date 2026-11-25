// SPDX-License-Identifier: Apache-2.0

import React, { useEffect } from 'react';

type AIChatRuntime = {
  chatBoxModel?: {
    chatBoxRef?: { current?: HTMLElement | null } | null;
  };
};

// shortcut: the AI plugin stores its global runtime internally; switch to a shared optional loader when one supports both clients.
type AIStoresGlobal = typeof globalThis & {
  __nocobasePluginAIStores?: Record<string, unknown>;
};

const GLOBAL_CHAT_STORE = '@nocobase/plugin-ai/chat-box-runtime';
const WIDTH_PROPERTY = '--advance-settings-ai-chat-width';

export const AIChatResize: React.FC<React.PropsWithChildren<{ enabled: boolean; label: string }>> = ({
  enabled,
  label,
  children,
}) => {
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') {
      return;
    }

    const root = document.documentElement;
    const style = document.createElement('style');
    style.textContent = `
      html[data-advance-ai-chat-resize] {
        padding-left: var(--advance-settings-ai-chat-width) !important;
      }
      html[data-advance-ai-chat-resize] body {
        transform: translateX(calc(0px - var(--advance-settings-ai-chat-width))) !important;
      }
      html[data-advance-ai-chat-resize] [data-advance-ai-chat-panel] {
        width: var(--advance-settings-ai-chat-width) !important;
        right: calc(0px - var(--advance-settings-ai-chat-width)) !important;
      }
      html[data-advance-ai-chat-resize] body .ant-dropdown-placement-topLeft,
      html[data-advance-ai-chat-resize] body .ant-dropdown-placement-bottomLeft,
      html[data-advance-ai-chat-resize] body .ant-dropdown-menu-submenu-placement-rightTop,
      html[data-advance-ai-chat-resize] body .ant-dropdown-menu-submenu-placement-rightBottom,
      html[data-advance-ai-chat-resize] body .ant-select-dropdown-placement-bottomLeft,
      html[data-advance-ai-chat-resize] body .ant-select-dropdown-placement-topLeft,
      html[data-advance-ai-chat-resize] body .ant-select-dropdown-placement-bottomRight,
      html[data-advance-ai-chat-resize] body .ant-select-dropdown-placement-topRight {
        transform: translateX(var(--advance-settings-ai-chat-width)) !important;
      }
      [data-advance-ai-chat-handle] {
        position: absolute;
        z-index: 100;
        left: 0;
        top: 0;
        width: 10px;
        height: 100%;
        cursor: col-resize;
        touch-action: none;
      }
      [data-advance-ai-chat-handle]::after {
        content: '';
        position: absolute;
        top: 50%;
        left: 3px;
        width: 3px;
        height: 48px;
        border-radius: 2px;
        background: rgba(128, 128, 128, 0.6);
        transform: translateY(-50%);
      }
      [data-advance-ai-chat-handle]:focus-visible {
        outline: 2px solid #1677ff;
        outline-offset: -2px;
      }
      html[data-advance-ai-chat-dragging],
      html[data-advance-ai-chat-dragging] * {
        cursor: col-resize !important;
        user-select: none !important;
      }
    `;
    document.head.appendChild(style);

    let panel: HTMLElement | null = null;
    let width = 450;
    let pointerId: number | null = null;
    let pointerStart = 0;
    let startWidth = width;
    let scheduledFrame: number | null = null;
    let retryTimer: number | null = null;
    let retryCount = 0;

    const handle = document.createElement('div');
    handle.dataset.advanceAiChatHandle = '';
    handle.dataset.testid = 'ai-chat-resize-handle';
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-label', label);
    handle.setAttribute('aria-orientation', 'vertical');
    handle.tabIndex = 0;

    const setWidth = (nextWidth: number) => {
      const maxWidth = Math.max(100, window.innerWidth - 240);
      const minWidth = Math.min(320, maxWidth);
      width = Math.round(Math.max(minWidth, Math.min(nextWidth, maxWidth)));
      root.style.setProperty(WIDTH_PROPERTY, `${width}px`);
      handle.setAttribute('aria-valuemin', String(minWidth));
      handle.setAttribute('aria-valuemax', String(maxWidth));
      handle.setAttribute('aria-valuenow', String(width));
    };

    const endDrag = () => {
      if (pointerId === null) {
        return;
      }
      const capturedPointer = pointerId;
      pointerId = null;
      if (handle.hasPointerCapture?.(capturedPointer)) {
        handle.releasePointerCapture(capturedPointer);
      }
      delete root.dataset.advanceAiChatDragging;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('blur', endDrag);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId === pointerId) {
        setWidth(startWidth + pointerStart - event.clientX);
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId === pointerId) {
        endDrag();
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || pointerId !== null) {
        return;
      }
      event.preventDefault();
      pointerId = event.pointerId;
      pointerStart = event.clientX;
      startWidth = width;
      root.dataset.advanceAiChatDragging = '';
      handle.setPointerCapture?.(event.pointerId);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
      window.addEventListener('blur', endDrag);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      let nextWidth: number;
      if (event.key === 'ArrowLeft') {
        nextWidth = width + 20;
      } else if (event.key === 'ArrowRight') {
        nextWidth = width - 20;
      } else if (event.key === 'Home') {
        nextWidth = 0;
      } else if (event.key === 'End') {
        nextWidth = window.innerWidth;
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setWidth(nextWidth);
    };
    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('keydown', onKeyDown);

    const detach = () => {
      endDrag();
      handle.remove();
      panel?.removeAttribute('data-advance-ai-chat-panel');
      panel = null;
      delete root.dataset.advanceAiChatResize;
      root.style.removeProperty(WIDTH_PROPERTY);
    };

    const isDockedPanel = (candidate: Element | null | undefined): candidate is HTMLElement =>
      candidate instanceof HTMLElement &&
      candidate.getAttribute('role') === 'dialog' &&
      candidate.style.position === 'fixed' &&
      candidate.style.height === '100vh' &&
      Number.parseFloat(candidate.style.right) < 0;

    const syncPanel = () => {
      const stores = (globalThis as AIStoresGlobal).__nocobasePluginAIStores;
      const runtime = stores?.[GLOBAL_CHAT_STORE] as AIChatRuntime | undefined;
      const candidate = runtime?.chatBoxModel?.chatBoxRef?.current?.parentElement;
      if (!isDockedPanel(candidate)) {
        if (panel) {
          detach();
        }
        const pendingPanel = Array.from(document.querySelectorAll('[role="dialog"]')).some(isDockedPanel);
        if (!pendingPanel) {
          retryCount = 0;
          if (retryTimer !== null) {
            window.clearTimeout(retryTimer);
            retryTimer = null;
          }
        } else if (retryTimer === null && retryCount < 20) {
          retryCount += 1;
          retryTimer = window.setTimeout(() => {
            retryTimer = null;
            syncPanel();
          }, 100);
        }
        return;
      }
      retryCount = 0;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (panel === candidate && handle.parentElement === candidate) {
        return;
      }
      detach();
      panel = candidate;
      panel.dataset.advanceAiChatPanel = '';
      panel.prepend(handle);
      root.dataset.advanceAiChatResize = '';
      setWidth(width);
    };

    const scheduleSync = () => {
      if (scheduledFrame !== null) {
        return;
      }
      scheduledFrame = window.requestAnimationFrame(() => {
        scheduledFrame = null;
        syncPanel();
      });
    };
    const observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, { childList: true, subtree: true });
    const onWindowResize = () => {
      if (panel) {
        setWidth(width);
      }
      scheduleSync();
    };
    window.addEventListener('resize', onWindowResize);
    syncPanel();

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onWindowResize);
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      if (scheduledFrame !== null) {
        window.cancelAnimationFrame(scheduledFrame);
      }
      detach();
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('keydown', onKeyDown);
      style.remove();
    };
  }, [enabled, label]);

  return <>{children}</>;
};
