/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockClient, useApp } from '@nocobase/client-v2';
import { filePreviewTypes } from '@nocobase/plugin-file-manager/client-v2';
import * as aiPluginClient from '@nocobase/plugin-ai/client-v2';
import type { ChatBoxRuntime } from '@nocobase/plugin-ai/client-v2';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAiChatFilePreviewEffect } from '../chatFilePreviewEffect';

const previewWindow = window as Window & { __pluginAiChatFilePreviewV2Cleanup?: () => void };

const createScope = (
  root: HTMLElement,
  files: Array<{ filename: string; url: string }>,
  senderAttachments: unknown[] = [],
): ChatBoxRuntime => {
  const baseRuntime = aiPluginClient.getGlobalChatBoxRuntime();
  return {
    ...baseRuntime,
    chatBoxModel: {
      ...baseRuntime.chatBoxModel,
      chatBoxRef: { current: root },
    },
    chatConversationModel: {
      ...baseRuntime.chatConversationModel,
      currentConversation: undefined,
    },
    chatMessageModel: {
      ...baseRuntime.chatMessageModel,
      getSessionState: () => ({ messages: [], attachments: files }),
    },
    chatSenderModel: {
      ...baseRuntime.chatSenderModel,
      attachments: senderAttachments,
    },
  } as ChatBoxRuntime;
};

const createFileCard = (filename: string, url: string) => {
  const card = document.createElement('div');
  card.className = 'ant-attachment-list-card';
  card.dataset.fileUrl = url;

  const name = document.createElement('span');
  name.className = 'ant-attachment-list-card-name';
  name.textContent = filename;
  card.append(name);

  const remove = document.createElement('button');
  remove.className = 'ant-attachment-list-card-remove';
  remove.textContent = 'Remove';
  card.append(remove);
  return { card, name, remove };
};

afterEach(() => {
  previewWindow.__pluginAiChatFilePreviewV2Cleanup?.();
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('AI file preview native V2 context', () => {
  it('opens real Ant Design X file cards from their own chat runtime and leaves remove actions alone', async () => {
    const app = createMockClient();
    const chatRoot = document.createElement('div');
    const bubble = document.createElement('div');
    bubble.className = 'ant-bubble';
    const { card, name, remove } = createFileCard('report.pdf', '/files/chat-report.pdf');
    bubble.append(card);
    chatRoot.append(bubble);
    document.body.append(chatRoot);
    const runtime = createScope(chatRoot, [{ filename: 'report.pdf', url: '/files/chat-report.pdf' }]);
    vi.spyOn(aiPluginClient, 'getGlobalChatBoxRuntime').mockReturnValue(runtime);
    const previewer = vi.spyOn(filePreviewTypes, 'getTypeByFile').mockReturnValue({
      Previewer: ({ onClose }) => (
        <button onClick={onClose}>{useApp() === app ? 'Native preview context' : 'Missing context'}</button>
      ),
    });
    installAiChatFilePreviewEffect(app);

    fireEvent.click(remove);
    expect(previewer).not.toHaveBeenCalled();
    fireEvent.click(name);

    expect(await screen.findByRole('button', { name: 'Native preview context' })).toBeTruthy();
    expect(previewer.mock.calls[0][0]).toEqual(expect.objectContaining({ url: '/files/chat-report.pdf' }));
  });

  it('does not intercept an unrelated file link outside the mounted AI chat', () => {
    const app = createMockClient();
    const chatRoot = document.createElement('div');
    const card = createFileCard('report.pdf', '/files/report.pdf');
    chatRoot.append(card.card);
    document.body.append(chatRoot);
    const outsideLink = document.createElement('a');
    outsideLink.href = '/files/report.pdf';
    outsideLink.textContent = 'report.pdf';
    document.body.append(outsideLink);
    let interceptedBeforeTarget = false;
    outsideLink.addEventListener('click', (event) => {
      interceptedBeforeTarget = event.defaultPrevented;
      event.preventDefault();
    });
    const runtime = createScope(chatRoot, [{ filename: 'report.pdf', url: '/files/report.pdf' }]);
    vi.spyOn(aiPluginClient, 'getGlobalChatBoxRuntime').mockReturnValue(runtime);
    vi.spyOn(filePreviewTypes, 'getTypeByFile');
    installAiChatFilePreviewEffect(app);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    outsideLink.dispatchEvent(event);

    expect(interceptedBeforeTarget).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(outsideLink.getAttribute('href')).toBe('/files/report.pdf');
    expect(outsideLink.href).not.toContain('token=');
    expect(filePreviewTypes.getTypeByFile).not.toHaveBeenCalled();
  });

  it('uses each block runtime when two chats contain files with the same name', async () => {
    const app = createMockClient();
    const globalRoot = document.createElement('div');
    const blockRoot = document.createElement('div');
    const globalCard = createFileCard('report.pdf', '/files/global-report.pdf');
    const blockCard = createFileCard('report.pdf', '/files/block-report.pdf');
    globalRoot.append(globalCard.card);
    blockRoot.append(blockCard.card);
    document.body.append(globalRoot, blockRoot);

    const globalRuntime = createScope(globalRoot, [{ filename: 'report.pdf', url: '/files/global-report.pdf' }]);
    const blockRuntime = createScope(blockRoot, [{ filename: 'report.pdf', url: '/files/block-report.pdf' }]);
    vi.spyOn(aiPluginClient, 'getGlobalChatBoxRuntime').mockReturnValue(globalRuntime);
    const model = { chatBoxRuntime: blockRuntime };
    vi.spyOn(app.flowEngine, 'forEachModel').mockImplementation((callback) => {
      callback(model as never);
    });
    const previewer = vi.spyOn(filePreviewTypes, 'getTypeByFile').mockReturnValue({ Previewer: () => null });
    installAiChatFilePreviewEffect(app);

    fireEvent.click(globalCard.name);
    await waitFor(() => expect(previewer).toHaveBeenCalled());
    expect(previewer.mock.calls[0][0].url).toBe('/files/global-report.pdf');

    previewer.mockClear();
    fireEvent.click(blockCard.name);
    await waitFor(() => expect(previewer).toHaveBeenCalled());
    expect(previewer.mock.calls[0][0].url).toBe('/files/block-report.pdf');
  });

  it('does not guess between same-name files in one runtime when a card has no URL', () => {
    const app = createMockClient();
    const chatRoot = document.createElement('div');
    const { card, name } = createFileCard('report.pdf', '');
    chatRoot.append(card);
    document.body.append(chatRoot);
    const runtime = createScope(chatRoot, [
      { filename: 'report.pdf', url: '/files/first-report.pdf' },
      { filename: 'report.pdf', url: '/files/second-report.pdf' },
    ]);
    vi.spyOn(aiPluginClient, 'getGlobalChatBoxRuntime').mockReturnValue(runtime);
    const previewer = vi.spyOn(filePreviewTypes, 'getTypeByFile');
    installAiChatFilePreviewEffect(app);

    fireEvent.click(name);

    expect(previewer).not.toHaveBeenCalled();
  });

  it('preserves pending sender File objects for native previews', async () => {
    const app = createMockClient();
    const chatRoot = document.createElement('div');
    const { card, name } = createFileCard('draft.txt', '');
    chatRoot.append(card);
    document.body.append(chatRoot);
    const upload = new File(['draft'], 'draft.txt', { type: 'text/plain' });
    const runtime = createScope(chatRoot, [], [upload]);
    vi.spyOn(aiPluginClient, 'getGlobalChatBoxRuntime').mockReturnValue(runtime);
    const previewer = vi.spyOn(filePreviewTypes, 'getTypeByFile').mockReturnValue({ Previewer: () => null });
    installAiChatFilePreviewEffect(app);

    fireEvent.click(name);

    await waitFor(() => expect(previewer).toHaveBeenCalled());
    expect(previewer.mock.calls[0][0]).toEqual(
      expect.objectContaining({ filename: 'draft.txt', originFileObj: upload }),
    );
  });

  it('reads files from the currently selected conversation session', async () => {
    const app = createMockClient();
    const chatRoot = document.createElement('div');
    const { card, name } = createFileCard('report.pdf', '');
    chatRoot.append(card);
    document.body.append(chatRoot);
    const baseRuntime = aiPluginClient.getGlobalChatBoxRuntime();
    let activeConversation = 'conversation-b';
    const runtime = {
      ...baseRuntime,
      chatBoxModel: { ...baseRuntime.chatBoxModel, chatBoxRef: { current: chatRoot } },
      chatConversationModel: {
        ...baseRuntime.chatConversationModel,
        get currentConversation() {
          return activeConversation;
        },
      },
      chatMessageModel: {
        ...baseRuntime.chatMessageModel,
        getSessionState: (sessionId?: string) => ({
          messages: [],
          attachments:
            sessionId === 'conversation-a'
              ? [{ filename: 'report.pdf', url: '/files/conversation-a.pdf' }]
              : [{ filename: 'report.pdf', url: '/files/conversation-b.pdf' }],
        }),
      },
      chatSenderModel: { ...baseRuntime.chatSenderModel, attachments: [] },
    } as ChatBoxRuntime;
    vi.spyOn(aiPluginClient, 'getGlobalChatBoxRuntime').mockReturnValue(runtime);
    const previewer = vi.spyOn(filePreviewTypes, 'getTypeByFile').mockReturnValue({ Previewer: () => null });
    installAiChatFilePreviewEffect(app);

    fireEvent.click(name);
    await waitFor(() => expect(previewer).toHaveBeenCalled());
    expect(previewer.mock.calls[0][0].url).toBe('/files/conversation-b.pdf');

    activeConversation = 'conversation-a';
    previewer.mockClear();
    fireEvent.click(name);
    await waitFor(() => expect(previewer).toHaveBeenCalled());
    expect(previewer.mock.calls[0][0].url).toBe('/files/conversation-a.pdf');
  });

  it('provides FlowEngine context to detached native File Manager previewers', async () => {
    const app = createMockClient();
    const chatRoot = document.createElement('div');
    const { card, name } = createFileCard('report.pdf', '/files/report.pdf');
    chatRoot.append(card);
    document.body.append(chatRoot);
    const runtime = createScope(chatRoot, [{ filename: 'report.pdf', url: '/files/report.pdf' }]);
    vi.spyOn(aiPluginClient, 'getGlobalChatBoxRuntime').mockReturnValue(runtime);
    vi.spyOn(filePreviewTypes, 'getTypeByFile').mockReturnValue({
      Previewer: ({ onClose }) => (
        <button onClick={onClose}>{useApp() === app ? 'Native preview context' : 'Missing context'}</button>
      ),
    });
    installAiChatFilePreviewEffect(app);

    fireEvent.click(name);
    fireEvent.click(await screen.findByRole('button', { name: 'Native preview context' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Native preview context' })).toBeNull());
  });
});
