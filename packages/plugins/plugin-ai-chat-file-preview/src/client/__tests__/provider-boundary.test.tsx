// SPDX-License-Identifier: Apache-2.0

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { message } from 'antd';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentPreviewController } from '../../../../plugin-file-preview-auth/src/shared/DocumentPreviewModal';
import { readBlobBytes } from '../../../../plugin-file-preview-auth/src/shared/documentPreview';

const { appMock, getGlobalChatBoxRuntimeMock, openDocumentPreviewMock } = vi.hoisted(() => {
  const openDocumentPreviewMock = vi.fn();
  const pmGet = vi.fn((name: string) =>
    name === 'plugin-file-preview-auth' ? { openDocumentPreview: openDocumentPreviewMock } : undefined,
  );
  return {
    openDocumentPreviewMock,
    appMock: {
      name: 'main',
      apiClient: {
        appName: 'main',
        auth: { token: 'v1-jwt-token', role: 'member', locale: 'en-US' },
        axios: { defaults: { baseURL: '/api/' } },
        getHeaders: () => ({ Authorization: 'Bearer v1-jwt-token', 'X-Role': 'member', 'X-App': 'main' }),
      },
      pm: { get: pmGet },
      flowEngine: { previousEngine: undefined, forEachModel: vi.fn(), nextEngine: undefined },
      i18n: { t: (key: string) => key },
    },
    getGlobalChatBoxRuntimeMock: vi.fn(),
  };
});

vi.mock('@nocobase/client', () => ({
  useAPIClient: () => appMock.apiClient,
  useApp: () => appMock,
}));

vi.mock('@nocobase/plugin-ai/client-v2', () => ({
  getGlobalChatBoxRuntime: getGlobalChatBoxRuntimeMock,
}));

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

beforeEach(() => {
  appMock.pm.get = vi.fn((name: string) =>
    name === 'plugin-file-preview-auth' ? { openDocumentPreview: openDocumentPreviewMock } : undefined,
  );
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AI Chat File Preview v1 provider contract', () => {
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

  it('delegates persisted aiFiles cards, File Manager links, and Skill Hub links to openDocumentPreview with exact source identity', () => {
    const chatRoot = document.createElement('div');
    const b1 = document.createElement('div');
    b1.className = 'ant-bubble';
    const card = document.createElement('div');
    card.className = 'ant-attachment-list-card';
    const cardName = document.createElement('span');
    cardName.className = 'ant-attachment-list-card-name';
    cardName.textContent = 'brief.pdf';
    card.append(cardName);
    b1.append(card);

    const b2 = document.createElement('div');
    b2.className = 'ant-bubble';
    const fmLink = document.createElement('a');
    fmLink.setAttribute('href', '/files/main/main/attachments/88.pdf');
    fmLink.textContent = 'invoice.pdf';
    b2.append(fmLink);

    const b3 = document.createElement('div');
    b3.className = 'ant-bubble';
    const run1Link = document.createElement('a');
    run1Link.setAttribute('href', 'sandbox:download/report.xlsx');
    run1Link.textContent = 'report.xlsx';
    b3.append(run1Link);

    const b4 = document.createElement('div');
    b4.className = 'ant-bubble';
    const run2Link = document.createElement('a');
    run2Link.setAttribute('href', 'sandbox:download/report.xlsx');
    run2Link.textContent = 'report.xlsx';
    b4.append(run2Link);

    chatRoot.append(b1, b2, b3, b4);
    document.body.append(chatRoot);

    const manifest1 = `<!--skillhub:files ${JSON.stringify([
      { name: 'report.xlsx', downloadUrl: '/api/skillHub:download?execId=run-1&filename=report.xlsx', execId: 'run-1' },
    ])}-->`;
    const manifest2 = `<!--skillhub:files ${JSON.stringify([
      { name: 'report.xlsx', downloadUrl: '/api/skillHub:download?execId=run-2&filename=report.xlsx', execId: 'run-2' },
    ])}-->`;

    const messages = [
      { content: { attachments: [{ id: 101, filename: 'brief.pdf', collectionName: 'aiFiles', status: 'done' }] } },
      { content: 'See [invoice.pdf](/files/main/main/attachments/88.pdf)' },
      {
        content: { content: 'Run 1 [report.xlsx](sandbox:download/report.xlsx)', tool_calls: [{ content: manifest1 }] },
      },
      {
        content: { content: 'Run 2 [report.xlsx](sandbox:download/report.xlsx)', tool_calls: [{ content: manifest2 }] },
      },
    ];

    getGlobalChatBoxRuntimeMock.mockReturnValue({
      chatBoxModel: { chatBoxRef: { current: chatRoot } },
      chatConversationModel: { currentConversation: 'conv-1' },
      chatMessageModel: { getSessionState: () => ({ messages, attachments: [] }) },
      chatSenderModel: { attachments: [] },
    });

    render(
      <ChatFilePreviewProvider>
        <div>Application content</div>
      </ChatFilePreviewProvider>,
    );

    fireEvent.click(cardName);
    expect(openDocumentPreviewMock).toHaveBeenLastCalledWith({
      kind: 'record',
      collection: 'aiFiles',
      id: 101,
      displayName: 'brief.pdf',
    });

    fireEvent.click(fmLink);
    expect(openDocumentPreviewMock).toHaveBeenLastCalledWith({
      kind: 'record',
      collection: 'attachments',
      id: '88',
      displayName: 'invoice.pdf',
    });

    // Two runs generating report.xlsx MUST open each run separately and NEVER mutate session.messages!
    fireEvent.click(run1Link);
    expect(openDocumentPreviewMock).toHaveBeenLastCalledWith({
      kind: 'skillHub',
      execId: 'run-1',
      filename: 'report.xlsx',
      displayName: 'report.xlsx',
    });

    fireEvent.click(run2Link);
    expect(openDocumentPreviewMock).toHaveBeenLastCalledWith({
      kind: 'skillHub',
      execId: 'run-2',
      filename: 'report.xlsx',
      displayName: 'report.xlsx',
    });

    expect((messages[2].content as { content: string }).content).toBe(
      'Run 1 [report.xlsx](sandbox:download/report.xlsx)',
    );
  });

  it('prevents navigation and warns when plugin-file-preview-auth is missing or outdated', () => {
    const warnSpy = vi.spyOn(message, 'warning').mockImplementation((() => {}) as never);
    appMock.pm.get = vi.fn(() => ({})); // Old plugin without openDocumentPreview

    const chatRoot = document.createElement('div');
    const link = document.createElement('a');
    link.setAttribute('href', '/files/main/main/attachments/19.pdf');
    link.textContent = 'policy.pdf';
    chatRoot.append(link);
    document.body.append(chatRoot);

    getGlobalChatBoxRuntimeMock.mockReturnValue({
      chatBoxModel: { chatBoxRef: { current: chatRoot } },
      chatConversationModel: { currentConversation: 'conv-1' },
      chatMessageModel: { getSessionState: () => ({ messages: [], attachments: [] }) },
      chatSenderModel: { attachments: [] },
    });

    render(
      <ChatFilePreviewProvider>
        <div>Application content</div>
      </ChatFilePreviewProvider>,
    );

    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(clickEvent);

    expect(clickEvent.defaultPrevented).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      'Please enable or update Authenticated File Previewer (plugin-file-preview-auth) to preview this document.',
    );
  });

  it('runs end-to-end v1 chat click -> single authenticated fetch -> offline Blob download', async () => {
    const createdUrls: Array<{ url: string; blob: Blob }> = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn((blob: Blob) => {
        const url = `blob:v1-${createdUrls.length + 1}`;
        createdUrls.push({ url, blob });
        return url;
      }),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const controller = new DocumentPreviewController(appMock);
    appMock.pm.get = vi.fn((name: string) =>
      name === 'plugin-file-preview-auth' ? { openDocumentPreview: controller.openDocumentPreview } : undefined,
    );

    const payloadText = 'V1 End-to-End Authenticated Chat Document — Tiếng Việt';
    const payloadBytes = new TextEncoder().encode(payloadText);
    const blob = new Blob([payloadBytes], { type: 'text/plain; charset=utf-8' });
    Object.defineProperty(blob, 'arrayBuffer', {
      value: async () =>
        payloadBytes.buffer.slice(payloadBytes.byteOffset, payloadBytes.byteOffset + payloadBytes.byteLength),
    });
    Object.defineProperty(blob, 'slice', { value: () => blob });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="v1-notes.txt"',
        }),
        blob: async () => blob,
      })
      .mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', fetchMock);

    const chatRoot = document.createElement('div');
    const card = document.createElement('div');
    card.className = 'ant-attachment-list-card';
    card.textContent = 'v1-notes.txt';
    chatRoot.append(card);
    document.body.append(chatRoot);

    getGlobalChatBoxRuntimeMock.mockReturnValue({
      chatBoxModel: { chatBoxRef: { current: chatRoot } },
      chatConversationModel: { currentConversation: 'conv-1' },
      chatMessageModel: {
        getSessionState: () => ({
          messages: [],
          attachments: [{ id: 77, filename: 'v1-notes.txt', collectionName: 'aiFiles', status: 'done' }],
        }),
      },
      chatSenderModel: { attachments: [] },
    });

    render(
      <ChatFilePreviewProvider>
        <div>Application content</div>
      </ChatFilePreviewProvider>,
    );

    fireEvent.click(card);
    expect(await screen.findByText(payloadText)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/filePreviewAuth:streamDocument?collection=aiFiles&id=77');

    // Click Download while offline (fetch rejects on 2nd call)
    fireEvent.click(screen.getByRole('button', { name: /Download/i }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const downloadedBytes = await readBlobBytes(createdUrls[createdUrls.length - 1].blob);
    expect(new TextDecoder('utf-8').decode(downloadedBytes)).toBe(payloadText);

    controller.destroy();
  });
});
