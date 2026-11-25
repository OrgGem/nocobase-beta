// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useRef } from 'react';

const WIDTH_PROPERTY = '--advance-settings-left-nav-width';
const DEFAULT_SIDER_WIDTH = 200;
const MIN_SIDER_WIDTH = 160;

function isDockedLeftNav(candidate: Element | null | undefined): candidate is HTMLElement {
  return (
    candidate instanceof HTMLElement &&
    candidate.classList.contains('ant-layout-sider') &&
    candidate.classList.contains('ant-pro-sider') &&
    !candidate.classList.contains('ant-pro-sider-collapsed') &&
    !candidate.classList.contains('ant-layout-sider-collapsed') &&
    !candidate.classList.contains('ant-pro-sider-hide-menu-collapsed') &&
    !candidate.closest('.ant-drawer, .ant-pro-drawer-sider')
  );
}

function findFixedSiderPlaceholder(sider: HTMLElement): HTMLElement | null {
  if (!sider.classList.contains('ant-pro-sider-fixed')) {
    return null;
  }
  const previous = sider.previousElementSibling;
  return previous instanceof HTMLDivElement && !previous.classList.contains('ant-pro-layout-container')
    ? previous
    : null;
}

function resolveInitialWidth(sider: HTMLElement): number {
  const inlineWidth = Number.parseFloat(sider.style.width);
  if (Number.isFinite(inlineWidth) && inlineWidth > 0) {
    return inlineWidth;
  }
  const rectWidth = Math.round(sider.getBoundingClientRect().width);
  return rectWidth > 0 ? rectWidth : DEFAULT_SIDER_WIDTH;
}

function resolveLayoutContainer(sider: HTMLElement | null): HTMLElement {
  return (
    sider?.closest<HTMLElement>('#nocobase-app-container, #nocobase-nextapp-container, .ant-pro-layout') ??
    document.body
  );
}

function resolveAvailableWidth(container: HTMLElement | null): number {
  const containerWidth = container?.clientWidth ?? 0;
  if (containerWidth > 0) {
    return containerWidth;
  }
  const bodyWidth = document.body?.clientWidth ?? 0;
  return bodyWidth > 0 ? bodyWidth : window.innerWidth;
}

export const LeftNavResize: React.FC<React.PropsWithChildren<{ enabled: boolean; label: string }>> = ({
  enabled,
  label,
  children,
}) => {
  const handleRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef(label);
  labelRef.current = label;

  useEffect(() => {
    handleRef.current?.setAttribute('aria-label', label);
  }, [label]);

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') {
      return;
    }

    const root = document.documentElement;
    const style = document.createElement('style');
    style.dataset.advanceLeftNavStyle = '';
    style.textContent = `
      html[data-advance-left-nav-resize] [data-advance-left-nav-sider],
      html[data-advance-left-nav-resize] [data-advance-left-nav-placeholder] {
        width: var(${WIDTH_PROPERTY}) !important;
        min-width: var(${WIDTH_PROPERTY}) !important;
        max-width: var(${WIDTH_PROPERTY}) !important;
        flex: 0 0 var(${WIDTH_PROPERTY}) !important;
      }
      html[data-advance-left-nav-resize] #nocobase-app-container :not(.ant-pro-sider) > .ant-pro-sider-collapsed-button {
        left: calc(var(${WIDTH_PROPERTY}) - 12px) !important;
      }
      [data-advance-left-nav-handle] {
        position: absolute;
        z-index: 100;
        right: -6px;
        top: 0;
        width: 8px;
        height: 100%;
        cursor: col-resize;
        touch-action: pan-y;
      }
      @media (pointer: coarse) {
        [data-advance-left-nav-handle] {
          min-inline-size: 24px;
          right: -22px;
        }
      }
      [data-advance-left-nav-handle]::after {
        content: '';
        position: absolute;
        top: 50%;
        left: 0;
        width: 3px;
        height: 48px;
        border-radius: 2px;
        background: rgba(128, 128, 128, 0.6);
        transform: translateY(-50%);
      }
      [data-advance-left-nav-handle]:focus-visible {
        outline: 2px solid #1677ff;
        outline-offset: -2px;
      }
      html[data-advance-left-nav-dragging],
      html[data-advance-left-nav-dragging] * {
        cursor: col-resize !important;
        user-select: none !important;
      }
      html[data-advance-left-nav-dragging] [data-advance-left-nav-sider],
      html[data-advance-left-nav-dragging] [data-advance-left-nav-placeholder],
      html[data-advance-left-nav-dragging] #nocobase-app-container :not(.ant-pro-sider) > .ant-pro-sider-collapsed-button {
        transition: none !important;
      }
    `;
    document.head.appendChild(style);

    let sider: HTMLElement | null = null;
    let placeholder: HTMLElement | null = null;
    let observedContainer: HTMLElement | null = null;
    let width: number | null = null;
    let pointerId: number | null = null;
    let pointerStart = 0;
    let startWidth = DEFAULT_SIDER_WIDTH;
    let scheduledFrame: number | null = null;

    const handle = document.createElement('div');
    handleRef.current = handle;
    handle.dataset.advanceLeftNavHandle = '';
    handle.dataset.testid = 'left-nav-resize-handle';
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-label', labelRef.current);
    handle.setAttribute('aria-orientation', 'vertical');
    handle.tabIndex = 0;

    const setWidth = (nextWidth: number) => {
      const availableWidth = resolveAvailableWidth(observedContainer ?? resolveLayoutContainer(sider));
      const maxWidth = Math.max(100, availableWidth - 240);
      const minWidth = Math.min(MIN_SIDER_WIDTH, maxWidth);
      const clamped = Math.round(Math.max(minWidth, Math.min(nextWidth, maxWidth)));
      width = clamped;
      root.style.setProperty(WIDTH_PROPERTY, `${clamped}px`);
      handle.setAttribute('aria-valuemin', String(minWidth));
      handle.setAttribute('aria-valuemax', String(maxWidth));
      handle.setAttribute('aria-valuenow', String(clamped));
    };

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            if (sider && width !== null) {
              setWidth(width);
            }
          })
        : null;

    const endDrag = () => {
      if (pointerId === null) {
        return;
      }
      const capturedPointer = pointerId;
      pointerId = null;
      if (handle.hasPointerCapture?.(capturedPointer)) {
        handle.releasePointerCapture(capturedPointer);
      }
      delete root.dataset.advanceLeftNavDragging;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('blur', endDrag);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId === pointerId) {
        setWidth(startWidth + event.clientX - pointerStart);
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
      startWidth = width ?? DEFAULT_SIDER_WIDTH;
      root.dataset.advanceLeftNavDragging = '';
      handle.setPointerCapture?.(event.pointerId);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
      window.addEventListener('blur', endDrag);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const currentWidth = width ?? DEFAULT_SIDER_WIDTH;
      let nextWidth: number;
      if (event.key === 'ArrowRight') {
        nextWidth = currentWidth + 20;
      } else if (event.key === 'ArrowLeft') {
        nextWidth = currentWidth - 20;
      } else if (event.key === 'Home') {
        nextWidth = 0;
      } else if (event.key === 'End') {
        nextWidth = Number.MAX_SAFE_INTEGER;
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
      if (observedContainer) {
        resizeObserver?.unobserve(observedContainer);
        observedContainer = null;
      }
      sider?.removeAttribute('data-advance-left-nav-sider');
      placeholder?.removeAttribute('data-advance-left-nav-placeholder');
      sider = null;
      placeholder = null;
      delete root.dataset.advanceLeftNavResize;
      root.style.removeProperty(WIDTH_PROPERTY);
    };

    const syncSider = () => {
      const candidate = Array.from(document.querySelectorAll('.ant-layout-sider.ant-pro-sider')).find(isDockedLeftNav);
      if (!candidate) {
        if (sider) {
          detach();
        }
        return;
      }
      const nextPlaceholder = findFixedSiderPlaceholder(candidate);
      if (sider === candidate && placeholder === nextPlaceholder && handle.parentElement === candidate) {
        return;
      }
      detach();
      if (width === null) {
        width = resolveInitialWidth(candidate);
      }
      sider = candidate;
      placeholder = nextPlaceholder;
      observedContainer = resolveLayoutContainer(candidate);
      resizeObserver?.observe(observedContainer);
      sider.dataset.advanceLeftNavSider = '';
      if (placeholder) {
        placeholder.dataset.advanceLeftNavPlaceholder = '';
      }
      sider.append(handle);
      root.dataset.advanceLeftNavResize = '';
      setWidth(width);
    };

    const scheduleSync = () => {
      if (scheduledFrame !== null) {
        return;
      }
      scheduledFrame = window.requestAnimationFrame(() => {
        scheduledFrame = null;
        syncSider();
      });
    };

    const isRelevantMutation = (mutation: MutationRecord): boolean =>
      mutation.type === 'childList' ||
      mutation.target === sider ||
      (mutation.target instanceof HTMLElement && mutation.target.classList.contains('ant-pro-sider'));

    const observer = new MutationObserver((mutations) => {
      if (mutations.some(isRelevantMutation)) {
        scheduleSync();
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });

    const onWindowResize = () => {
      if (sider && width !== null) {
        setWidth(width);
      }
      scheduleSync();
    };
    window.addEventListener('resize', onWindowResize);
    syncSider();

    return () => {
      observer.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener('resize', onWindowResize);
      if (scheduledFrame !== null) {
        window.cancelAnimationFrame(scheduledFrame);
      }
      detach();
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('keydown', onKeyDown);
      handleRef.current = null;
      style.remove();
    };
  }, [enabled]);

  return <>{children}</>;
};
