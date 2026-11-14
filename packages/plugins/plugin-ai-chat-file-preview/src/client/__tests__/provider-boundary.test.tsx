// SPDX-License-Identifier: Apache-2.0

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { appMock, getGlobalChatBoxRuntimeMock, getTypeByFileMock } = vi.hoisted(() => ({
  appMock: {
    flowEngine: { previousEngine: undefined, forEachModel: vi.fn(), nextEngine: undefined },
    i18n: { t: (key: string) => key },
  },
  getGlobalChatBoxRuntimeMock: vi.fn(),
  getTypeByFileMock: vi.fn(),
}));

vi.mock('@nocobase/client', () => ({
  useAPIClient: () => ({ auth: { token: 'test-token' }, request: vi.fn(), resource: vi.fn() }),
  useApp: () => appMock,
  attachmentFileTypes: { getTypeByFile: getTypeByFileMock },
}));

vi.mock('@nocobase/plugin-ai/client-v2', () => ({
  getGlobalChatBoxRuntime: getGlobalChatBoxRuntimeMock,
}));

import { attachmentFileTypes } from '@nocobase/client';
import { ChatFilePreviewProvider } from '../ChatFilePreviewProvider';

class ParentErrorBoundary extends React.Component<React.PropsWithChildren, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    return this.state.hasError ? <div>Application error boundary</div> : this.props.children;
  }
}

function BrokenApplicationContent(): React.ReactNode {
  throw new Error('application render failure');
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('AI Chat File Preview provider boundary', () => {
  it('lets the application error boundary handle failures in application children', () => {
    render(
      <ParentErrorBoundary>
        <ChatFilePreviewProvider>
          <BrokenApplicationContent />
        </ChatFilePreviewProvider>
      </ParentErrorBoundary>,
    );

    expect(screen.getByText('Application error boundary')).toBeTruthy();
  });

  it('keeps the original file URL and does not invent an id for fallback previews', async () => {
    const chatRoot = document.createElement('div');
    const bubble = document.createElement('div');
    bubble.className = 'ant-bubble';
    const link = document.createElement('a');
    const rawUrl = '/api/attachments/stream?token=test-token%2Bvalue&filename=report.pdf';
    link.setAttribute('href', rawUrl);
    link.textContent = 'report.pdf';
    bubble.append(link);
    chatRoot.append(bubble);
    document.body.append(chatRoot);

    getGlobalChatBoxRuntimeMock.mockReturnValue({
      chatBoxModel: { chatBoxRef: { current: chatRoot } },
      chatConversationModel: { currentConversation: 'conversation-1' },
      chatMessageModel: { getSessionState: () => ({ messages: [], attachments: [] }) },
      chatSenderModel: { attachments: [] },
    });
    getTypeByFileMock.mockReturnValue({ Previewer: () => <div>File preview</div> });
    render(
      <ChatFilePreviewProvider>
        <div>Application content</div>
      </ChatFilePreviewProvider>,
    );

    fireEvent.click(link);

    await waitFor(() => expect(attachmentFileTypes.getTypeByFile).toHaveBeenCalled());
    expect(getGlobalChatBoxRuntimeMock).toHaveBeenCalled();
    const previewFile = getTypeByFileMock.mock.calls[0][0];
    expect(previewFile).toEqual(expect.objectContaining({ url: new URL(rawUrl, window.location.href).href }));
    expect(previewFile).not.toHaveProperty('id');
    expect(previewFile).not.toHaveProperty('uid');
    expect(link.getAttribute('href')).toBe(rawUrl);
  });
});
