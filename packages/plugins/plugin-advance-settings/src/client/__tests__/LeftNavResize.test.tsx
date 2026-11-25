// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LeftNavResize } from '../../shared/LeftNavResize';

const WIDTH_PROPERTY = '--advance-settings-left-nav-width';

function createDockedLeftNav(
  options: { width?: string; fixed?: boolean; collapsed?: boolean; inDrawer?: boolean } = {},
) {
  const { width = '200px', fixed = true, collapsed = false, inDrawer = false } = options;
  const appContainer = document.createElement('div');
  appContainer.id = 'nocobase-app-container';
  appContainer.dataset.leftNavTestFixture = '';

  const layout = document.createElement('section');
  layout.className = 'ant-layout ant-layout-has-sider';

  let placeholder: HTMLDivElement | null = null;
  if (fixed && !inDrawer) {
    placeholder = document.createElement('div');
    placeholder.style.width = width;
    placeholder.style.flex = `0 0 ${width}`;
    layout.append(placeholder);
  }

  const sider = document.createElement('aside');
  sider.className = [
    'ant-layout-sider',
    'ant-pro-sider',
    fixed ? 'ant-pro-sider-fixed' : '',
    collapsed ? 'ant-pro-sider-collapsed ant-layout-sider-collapsed' : '',
  ]
    .filter(Boolean)
    .join(' ');
  sider.style.width = width;

  const children = document.createElement('div');
  children.className = 'ant-layout-sider-children';
  sider.append(children);

  if (inDrawer) {
    const drawer = document.createElement('div');
    drawer.className = 'ant-drawer ant-pro-drawer-sider';
    drawer.append(sider);
    layout.append(drawer);
  } else {
    layout.append(sider);
  }

  const content = document.createElement('div');
  content.className = 'ant-pro-layout-container';
  layout.append(content);
  appContainer.append(layout);
  document.body.append(appContainer);

  return { appContainer, sider, placeholder };
}

function dispatchPointer(target: EventTarget, type: string, clientX: number, pointerId = 1, button = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { button, clientX, pointerId });
  target.dispatchEvent(event);
}

describe('LeftNavResize', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  });

  afterEach(() => {
    cleanup();
    document.querySelectorAll('[data-left-nav-test-fixture]').forEach((fixture) => fixture.remove());
    document.documentElement.removeAttribute('data-advance-left-nav-resize');
    document.documentElement.removeAttribute('data-advance-left-nav-dragging');
    document.documentElement.style.removeProperty(WIDTH_PROPERTY);
  });

  it('adds a keyboard-accessible resize handle only when enabled on an expanded desktop left navigator', async () => {
    const { sider, placeholder } = createDockedLeftNav({ width: '220px' });
    const view = render(
      <LeftNavResize enabled={false} label="Resize left navigator">
        <div>Application</div>
      </LeftNavResize>,
    );

    expect(screen.queryByTestId('left-nav-resize-handle')).toBeNull();

    view.rerender(
      <LeftNavResize enabled label="Resize left navigator">
        <div>Application</div>
      </LeftNavResize>,
    );

    const handle = await screen.findByTestId('left-nav-resize-handle');
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-label')).toBe('Resize left navigator');
    expect(handle.getAttribute('aria-valuenow')).toBe('220');
    expect(document.documentElement.hasAttribute('data-advance-left-nav-resize')).toBe(true);
    expect(sider.hasAttribute('data-advance-left-nav-sider')).toBe(true);
    expect(placeholder?.hasAttribute('data-advance-left-nav-placeholder')).toBe(true);
  });

  it('changes left navigator width in both directions with pointer input and aligns placeholder and collapse button', async () => {
    const unrelatedStyle = document.createElement('style');
    unrelatedStyle.dataset.leftNavTestFixture = '';
    unrelatedStyle.textContent = 'body { margin: 0; }';
    document.head.prepend(unrelatedStyle);

    createDockedLeftNav();
    render(
      <LeftNavResize enabled label="Resize left navigator">
        <div>Application</div>
      </LeftNavResize>,
    );

    const handle = await screen.findByTestId('left-nav-resize-handle');
    dispatchPointer(handle, 'pointerdown', 200);
    dispatchPointer(window, 'pointermove', 280);
    dispatchPointer(window, 'pointerup', 280);

    expect(document.documentElement.style.getPropertyValue(WIDTH_PROPERTY)).toBe('280px');
    expect(handle.getAttribute('aria-valuenow')).toBe('280');
    const styleText = document.querySelector('style[data-advance-left-nav-style]')?.textContent || '';
    expect(styleText).toContain('[data-advance-left-nav-placeholder]');
    expect(styleText).toContain('left: calc(var(--advance-settings-left-nav-width) - 12px)');
    expect(styleText).toContain('right: -6px;');

    dispatchPointer(handle, 'pointerdown', 280);
    dispatchPointer(window, 'pointermove', 180);
    dispatchPointer(window, 'pointerup', 180);
    expect(document.documentElement.style.getPropertyValue(WIDTH_PROPERTY)).toBe('180px');
    expect(handle.getAttribute('aria-valuenow')).toBe('180');
  });

  it('supports arrow keys, Home/End clamping, container width shrinking, and ignores unrelated class mutations', async () => {
    let resizeCallback: (() => void) | null = null;
    const originalResizeObserver = globalThis.ResizeObserver;
    class MockResizeObserver {
      constructor(cb: () => void) {
        resizeCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: MockResizeObserver });

    try {
      const { appContainer } = createDockedLeftNav();
      let containerWidth = 1024;
      Object.defineProperty(appContainer, 'clientWidth', {
        configurable: true,
        get: () => containerWidth,
      });

      render(
        <LeftNavResize enabled label="Resize left navigator">
          <div>Application</div>
        </LeftNavResize>,
      );

      const handle = await screen.findByTestId('left-nav-resize-handle');
      fireEvent.keyDown(handle, { key: 'ArrowRight' });
      expect(handle.getAttribute('aria-valuenow')).toBe('220');

      fireEvent.keyDown(handle, { key: 'ArrowLeft' });
      expect(handle.getAttribute('aria-valuenow')).toBe('200');

      fireEvent.keyDown(handle, { key: 'Home' });
      expect(handle.getAttribute('aria-valuenow')).toBe('160');

      fireEvent.keyDown(handle, { key: 'End' });
      expect(handle.getAttribute('aria-valuenow')).toBe('784');

      // Simulates docked AI Chat shrinking #nocobase-app-container while window.innerWidth stays 1024
      containerWidth = 574;
      resizeCallback?.();
      expect(handle.getAttribute('aria-valuemax')).toBe('334');
      expect(handle.getAttribute('aria-valuenow')).toBe('334');
      expect(document.documentElement.style.getPropertyValue(WIDTH_PROPERTY)).toBe('334px');

      const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
      const content = appContainer.querySelector('.ant-pro-layout-container') as HTMLElement;
      content.className = 'ant-pro-layout-container ant-table-cell-row-hover';
      await Promise.resolve();
      expect(rafSpy).not.toHaveBeenCalled();
      rafSpy.mockRestore();
    } finally {
      Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: originalResizeObserver });
    }
  });

  it('detaches when collapsed or inside a mobile drawer, preserves width on re-expand, and cleans up on disable', async () => {
    const mobileFixture = createDockedLeftNav({ inDrawer: true });
    const view = render(
      <LeftNavResize enabled label="Resize left navigator">
        <div>Application</div>
      </LeftNavResize>,
    );
    await waitFor(() => expect(screen.queryByTestId('left-nav-resize-handle')).toBeNull());
    mobileFixture.appContainer.remove();

    const { sider, placeholder } = createDockedLeftNav();
    const handle = await screen.findByTestId('left-nav-resize-handle');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle.getAttribute('aria-valuenow')).toBe('240');

    sider.classList.add('ant-pro-sider-collapsed', 'ant-layout-sider-collapsed');
    await waitFor(() => expect(screen.queryByTestId('left-nav-resize-handle')).toBeNull());
    expect(document.documentElement.hasAttribute('data-advance-left-nav-resize')).toBe(false);
    expect(document.documentElement.style.getPropertyValue(WIDTH_PROPERTY)).toBe('');

    sider.classList.remove('ant-pro-sider-collapsed', 'ant-layout-sider-collapsed');
    const restoredHandle = await screen.findByTestId('left-nav-resize-handle');
    expect(restoredHandle.getAttribute('aria-valuenow')).toBe('240');
    expect(document.documentElement.style.getPropertyValue(WIDTH_PROPERTY)).toBe('240px');

    // Simulates V1 AdminLayoutComponentV1 remounting ProLayout on menuRouteRefreshVersion changes
    placeholder?.remove();
    sider.remove();
    const remounted = createDockedLeftNav({ width: '200px' });
    const remountedHandle = await screen.findByTestId('left-nav-resize-handle');
    expect(remountedHandle.parentElement).toBe(remounted.sider);
    expect(remountedHandle.getAttribute('aria-valuenow')).toBe('240');
    expect(remounted.sider.hasAttribute('data-advance-left-nav-sider')).toBe(true);
    expect(remounted.placeholder?.hasAttribute('data-advance-left-nav-placeholder')).toBe(true);

    view.rerender(
      <LeftNavResize enabled={false} label="Resize left navigator">
        <div>Application</div>
      </LeftNavResize>,
    );
    expect(screen.queryByTestId('left-nav-resize-handle')).toBeNull();
    expect(document.documentElement.hasAttribute('data-advance-left-nav-resize')).toBe(false);
    expect(document.documentElement.style.getPropertyValue(WIDTH_PROPERTY)).toBe('');
    expect(remounted.sider.hasAttribute('data-advance-left-nav-sider')).toBe(false);
    expect(remounted.placeholder?.hasAttribute('data-advance-left-nav-placeholder')).toBe(false);
  });
});
