// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AIChatResize } from '../../shared/AIChatResize';

const GLOBAL_CHAT_STORE = '@nocobase/plugin-ai/chat-box-runtime';
const WIDTH_PROPERTY = '--advance-settings-ai-chat-width';

function setGlobalChatRef(current: HTMLElement | null) {
  Object.defineProperty(globalThis, '__nocobasePluginAIStores', {
    configurable: true,
    value: current
      ? {
          [GLOBAL_CHAT_STORE]: {
            chatBoxModel: {
              chatBoxRef: { current },
            },
          },
        }
      : {},
  });
}

function createDockedChat(right = '-450px') {
  const dialog = document.createElement('div');
  const chatRef = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.dataset.resizeTestFixture = '';
  dialog.style.position = 'fixed';
  dialog.style.height = '100vh';
  dialog.style.width = '450px';
  dialog.style.right = right;
  dialog.append(chatRef);
  document.body.append(dialog);
  setGlobalChatRef(chatRef);
  return dialog;
}

function dispatchPointer(target: EventTarget, type: string, clientX: number, pointerId = 1, button = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { button, clientX, pointerId });
  target.dispatchEvent(event);
}

describe('AIChatResize', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  });

  afterEach(() => {
    cleanup();
    document.querySelectorAll('[data-resize-test-fixture]').forEach((fixture) => fixture.remove());
    delete (globalThis as typeof globalThis & { __nocobasePluginAIStores?: unknown }).__nocobasePluginAIStores;
    document.documentElement.removeAttribute('data-advance-ai-chat-resize');
    document.documentElement.removeAttribute('data-advance-ai-chat-dragging');
    document.documentElement.style.removeProperty(WIDTH_PROPERTY);
  });

  it('adds a keyboard-accessible resize handle only for the enabled docked global chat', async () => {
    createDockedChat();
    const view = render(
      <AIChatResize enabled={false} label="Resize AI chat">
        <div>Application</div>
      </AIChatResize>,
    );

    expect(screen.queryByTestId('ai-chat-resize-handle')).toBeNull();

    view.rerender(
      <AIChatResize enabled label="Resize AI chat">
        <div>Application</div>
      </AIChatResize>,
    );

    const handle = await screen.findByTestId('ai-chat-resize-handle');
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-label')).toBe('Resize AI chat');
    expect(handle.getAttribute('aria-valuenow')).toBe('450');
    expect(document.documentElement.hasAttribute('data-advance-ai-chat-resize')).toBe(true);
  });

  it('changes panel width in both directions with pointer input and keeps page offsets aligned', async () => {
    const dialog = createDockedChat();
    render(
      <AIChatResize enabled label="Resize AI chat">
        <div>Application</div>
      </AIChatResize>,
    );

    const handle = await screen.findByTestId('ai-chat-resize-handle');
    dispatchPointer(handle, 'pointerdown', 574);
    dispatchPointer(window, 'pointermove', 514);
    dispatchPointer(window, 'pointerup', 514);

    expect(document.documentElement.style.getPropertyValue(WIDTH_PROPERTY)).toBe('510px');
    expect(handle.getAttribute('aria-valuenow')).toBe('510');
    expect(dialog.hasAttribute('data-advance-ai-chat-panel')).toBe(true);
    expect(document.querySelector('style')?.textContent).toContain(
      'right: calc(0px - var(--advance-settings-ai-chat-width))',
    );
    expect(document.querySelector('style')?.textContent).toContain(
      'padding-left: var(--advance-settings-ai-chat-width)',
    );

    dispatchPointer(handle, 'pointerdown', 514);
    dispatchPointer(window, 'pointermove', 544);
    dispatchPointer(window, 'pointerup', 544);
    expect(document.documentElement.style.getPropertyValue(WIDTH_PROPERTY)).toBe('480px');
    expect(handle.getAttribute('aria-valuenow')).toBe('480');
  });

  it('supports arrow keys, min/max clamping, and viewport changes', async () => {
    createDockedChat();
    render(
      <AIChatResize enabled label="Resize AI chat">
        <div>Application</div>
      </AIChatResize>,
    );

    const handle = await screen.findByTestId('ai-chat-resize-handle');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle.getAttribute('aria-valuenow')).toBe('470');

    fireEvent.keyDown(handle, { key: 'Home' });
    expect(handle.getAttribute('aria-valuenow')).toBe('320');
    fireEvent.keyDown(handle, { key: 'End' });
    expect(handle.getAttribute('aria-valuenow')).toBe('784');

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => expect(handle.getAttribute('aria-valuenow')).toBe('360'));
  });

  it('ignores other or fullscreen dialogs and cleans up when disabled or the docked chat closes', async () => {
    const dialog = createDockedChat('0px');
    const view = render(
      <AIChatResize enabled label="Resize AI chat">
        <div>Application</div>
      </AIChatResize>,
    );
    await waitFor(() => expect(screen.queryByTestId('ai-chat-resize-handle')).toBeNull());

    dialog.remove();
    const dockedDialog = createDockedChat();
    const handle = await screen.findByTestId('ai-chat-resize-handle');

    view.rerender(
      <AIChatResize enabled={false} label="Resize AI chat">
        <div>Application</div>
      </AIChatResize>,
    );
    expect(screen.queryByTestId('ai-chat-resize-handle')).toBeNull();
    expect(document.documentElement.hasAttribute('data-advance-ai-chat-resize')).toBe(false);
    expect(document.documentElement.style.getPropertyValue(WIDTH_PROPERTY)).toBe('');
    expect(dockedDialog.hasAttribute('data-advance-ai-chat-panel')).toBe(false);

    view.rerender(
      <AIChatResize enabled label="Resize AI chat">
        <div>Application</div>
      </AIChatResize>,
    );
    await screen.findByTestId('ai-chat-resize-handle');
    dockedDialog.remove();
    await waitFor(() => expect(screen.queryByTestId('ai-chat-resize-handle')).toBeNull());
    expect(handle.parentElement).toBeNull();
  });

  it('does not install a resize handle when the AI employee runtime is unavailable', async () => {
    setGlobalChatRef(null);
    render(
      <AIChatResize enabled label="Resize AI chat">
        <div>Application</div>
      </AIChatResize>,
    );

    await waitFor(() => expect(screen.queryByTestId('ai-chat-resize-handle')).toBeNull());
    expect(document.documentElement.hasAttribute('data-advance-ai-chat-resize')).toBe(false);
  });
});
