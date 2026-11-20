// SPDX-License-Identifier: Apache-2.0

import { createMockClient } from '@nocobase/client-v2';
import * as aiPluginClient from '@nocobase/plugin-ai/client-v2';
import type { ChatBoxRuntime } from '@nocobase/plugin-ai/client-v2';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { message } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentPreviewController } from '../../../../plugin-file-preview-auth/src/shared/DocumentPreviewModal';
import { readBlobBytes } from '../../../../plugin-file-preview-auth/src/shared/documentPreview';
import { installAiChatFilePreviewEffect } from '../chatFilePreviewEffect';

const previewWindow = window as Window & { __pluginAiChatFilePreviewV2Cleanup?: () => void };

const createScope = (
  root: HTMLElement,
  files: unknown[],
  senderAttachments: unknown[] = [],
  messages: unknown[] = [],
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
      currentConversation: 'conv-default',
    },
    chatMessageModel: {
      ...baseRuntime.chatMessageModel,
      getSessionState: () => ({ messages, attachments: files }),
    },
    chatSenderModel: {
      ...baseRuntime.chatSenderModel,
      attachments: senderAttachments,
    },
  } as ChatBoxRuntime;
};

const createFileCard = (filename: string, url = '') => {
  const card = document.createElement('div');
  card.className = 'ant-attachment-list-card';
  if (url) {
    card.dataset.fileUrl = url;
  }

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

const attachPreviewPluginMock = (app: ReturnType<typeof createMockClient>) => {
  const openDocumentPreview = vi.fn();
  vi.spyOn(app.pm, 'get').mockImplementation(((name: string) => {
    if (name === 'plugin-file-preview-auth' || name === 'file-preview-auth') {
      return { openDocumentPreview };
    }
    return undefined;
  }) as never);
  return openDocumentPreview;
};

afterEach(() => {
  previewWindow.__pluginAiChatFilePreviewV2Cleanup?.();
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AI file preview V2 unified contract', () => {
  it('opens persisted Ant Design X file cards (including response.data.id) via openDocumentPreview and leaves remove actions alone', () => {
    const app = createMockClient();
    const openDocumentPreview = attachPreviewPluginMock(app);

    const chatRoot = document.createElement('div');
    const bubble = document.createElement('div');
    bubble.className = 'ant-bubble';
    const { card, name, remove } = createFileCard('report.pdf');
    bubble.append(card);
    chatRoot.append(bubble);
    document.body.append(chatRoot);

    const runtime = createScope(chatRoot, [
      {
        uid: 'rc-upload-123',
        filename: 'report.pdf',
        status: 'done',
        response: { data: { id: 301, collectionName: 'aiFiles', filename: 'report.pdf' } },
      },
    ]);
    vi.spyOn(aiPluginClient, 'getGlobalChatBoxRuntime').mockReturnValue(runtime);
    installAiChatFilePreviewEffect(app);

    fireEvent.click(remove);
    expect(openDocumentPreview).not.toHaveBeenCalled();

    fireEvent.click(name);
    expect(openDocumentPreview).toHaveBeenCalledTimes(1);
    expect(openDocumentPreview).toHaveBeenCalledWith({
      kind: 'record',
      collection: 'aiFiles',
      id: 301,
      displayName: 'report.pdf',
    });
  });

  it('does NOT intercept pending/uploading files, raw File objects, images, videos, external links, or out-of-scope routes', () => {
    const app = createMockClient();
    const openDocumentPreview = attachPreviewPluginMock(app);

    const chatRoot = document.createElement('div');
    const pendingCard = createFileCard('draft.txt');
    const uploadingCard = createFileCard('uploading.pdf');
    const imageCard = createFileCard('photo.png');
    const videoLink = document.createElement('a');
    videoLink.setAttribute('href', '/files/main/main/attachments/10.mp4');
    videoLink.textContent = 'demo.mp4';
    const externalLink = document.createElement('a');
    externalLink.setAttribute('href', 'https://bucket.s3.amazonaws.com/secret.pdf');
    externalLink.textContent = 'secret.pdf';
    const workerLink = document.createElement('a');
    workerLink.setAttribute('href', '/api/worker-monitor/logs/run.txt');
    workerLink.textContent = 'run.txt';
    const extStorageLink = document.createElement('a');
    extStorageLink.setAttribute('href', '/api/extStorage:download?id=5');
    extStorageLink.textContent = 'ext.pdf';
    const wrongAppLink = document.createElement('a');
    wrongAppLink.setAttribute('href', '/files/other-app/main/attachments/55.pdf');
    wrongAppLink.textContent = 'other-app.pdf';
    const wrongDsLink = document.createElement('a');
    wrongDsLink.setAttribute('href', '/files/main/secondary/attachments/55.pdf');
    wrongDsLink.textContent = 'other-ds.pdf';
    const wrongColLink = document.createElement('a');
    wrongColLink.setAttribute('href', '/files/main/main/users/55.pdf');
    wrongColLink.textContent = 'users.pdf';

    chatRoot.append(
      pendingCard.card,
      uploadingCard.card,
      imageCard.card,
      videoLink,
      externalLink,
      workerLink,
      extStorageLink,
      wrongAppLink,
      wrongDsLink,
      wrongColLink,
    );
    document.body.append(chatRoot);

    const rawUpload = new File(['draft'], 'draft.txt', { type: 'text/plain' });
    const runtime = createScope(
      chatRoot,
      [
        { id: 12, filename: 'uploading.pdf', status: 'uploading' },
        { id: 13, filename: 'photo.png', mimetype: 'image/png', status: 'done' },
      ],
      [rawUpload],
    );
    vi.spyOn(aiPluginClient, 'getGlobalChatBoxRuntime').mockReturnValue(runtime);
    installAiChatFilePreviewEffect(app);

    for (const el of [
      pendingCard.name,
      uploadingCard.name,
      imageCard.name,
      videoLink,
      externalLink,
      workerLink,
      extStorageLink,
      wrongAppLink,
      wrongDsLink,
      wrongColLink,
    ]) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      let preventedBeforeTarget = false;
      el.addEventListener(
        'click',
        (e) => {
          preventedBeforeTarget = e.defaultPrevented;
          e.preventDefault();
        },
        { once: true },
      );
      el.dispatchEvent(event);
      expect(preventedBeforeTarget).toBe(false);
    }

    expect(openDocumentPreview).not.toHaveBeenCalled();
  });

  it('isolates two chat blocks with same-named files AND maps AIChatBoxView Messages side panel to its own block runtime', () => {
    const app = createMockClient();
    const openDocumentPreview = attachPreviewPluginMock(app);

    // Block 1 has AIChatBoxView outer Layout + SidePanel Messages (Show messages = off) + inner Layout with header & coreRef
    const block1OuterLayout = document.createElement('div');
    block1OuterLayout.className = 'ant-layout';
    const block1SidePanel = document.createElement('div');
    const block1SideCard = createFileCard('report.pdf');
    block1SidePanel.append(block1SideCard.card);
    const block1InnerLayout = document.createElement('div');
    block1InnerLayout.className = 'ant-layout';
    const block1Header = document.createElement('header');
    block1Header.className = 'ant-layout-header ai-chat-box-header';
    const block1CoreRoot = document.createElement('div');
    block1InnerLayout.append(block1Header, block1CoreRoot);
    block1OuterLayout.append(block1SidePanel, block1InnerLayout);

    // Block 2 is a second independent chat block on the same page with the SAME filename report.pdf
    const block2OuterLayout = document.createElement('div');
    block2OuterLayout.className = 'ant-layout';
    const block2InnerLayout = document.createElement('div');
    block2InnerLayout.className = 'ant-layout';
    const block2Header = document.createElement('header');
    block2Header.className = 'ant-layout-header ai-chat-box-header';
    const block2CoreRoot = document.createElement('div');
    const block2Card = createFileCard('report.pdf');
    block2CoreRoot.append(block2Card.card);
    block2InnerLayout.append(block2Header, block2CoreRoot);
    block2OuterLayout.append(block2InnerLayout);

    document.body.append(block1OuterLayout, block2OuterLayout);

    const block1Runtime = createScope(block1CoreRoot, [{ id: 1001, filename: 'report.pdf', status: 'done' }]);
    const block2Runtime = createScope(block2CoreRoot, [{ id: 2002, filename: 'report.pdf', status: 'done' }]);
    vi.spyOn(aiPluginClient, 'getGlobalChatBoxRuntime').mockReturnValue(undefined as never);
    const models = [{ chatBoxRuntime: block1Runtime }, { chatBoxRuntime: block2Runtime }];
    vi.spyOn(app.flowEngine, 'forEachModel').mockImplementation((callback) => {
      for (const model of models) {
        callback(model as never);
      }
    });

    installAiChatFilePreviewEffect(app);

    // Clicking inside Block 1's Messages side panel resolves Block 1's record 1001!
    fireEvent.click(block1SideCard.name);
    expect(openDocumentPreview).toHaveBeenLastCalledWith({
      kind: 'record',
      collection: 'aiFiles',
      id: 1001,
      displayName: 'report.pdf',
    });

    // Clicking inside Block 2 resolves Block 2's record 2002!
    fireEvent.click(block2Card.name);
    expect(openDocumentPreview).toHaveBeenLastCalledWith({
      kind: 'record',
      collection: 'aiFiles',
      id: 2002,
      displayName: 'report.pdf',
    });
  });

  it('refuses to guess when multiple distinct persisted records share the same filename and card has no URL', () => {
    const app = createMockClient();
    const openDocumentPreview = attachPreviewPluginMock(app);

    const chatRoot = document.createElement('div');
    const { card, name } = createFileCard('report.pdf');
    chatRoot.append(card);
    document.body.append(chatRoot);

    const runtime = createScope(chatRoot, [
      { id: 1, filename: 'report.pdf', status: 'done' },
      { id: 2, filename: 'report.pdf', status: 'done' },
    ]);
    vi.spyOn(aiPluginClient, 'getGlobalChatBoxRuntime').mockReturnValue(runtime);
    installAiChatFilePreviewEffect(app);

    fireEvent.click(name);
    expect(openDocumentPreview).not.toHaveBeenCalled();
  });

  it('resolves Skill Hub links with both f (base64url UTF-8) and filename, and distinguishes two runs producing report.xlsx', () => {
    const app = createMockClient();
    const openDocumentPreview = attachPreviewPluginMock(app);

    const chatRoot = document.createElement('div');
    const b1 = document.createElement('div');
    b1.className = 'ant-bubble';
    const b1Link = document.createElement('a');
    b1Link.setAttribute('href', 'sandbox:download/report.xlsx');
    b1Link.textContent = 'report.xlsx';
    b1.append(b1Link);

    const b2 = document.createElement('div');
    b2.className = 'ant-bubble';
    const b2Link = document.createElement('a');
    b2Link.setAttribute('href', 'sandbox:download/report.xlsx');
    b2Link.textContent = 'report.xlsx';
    b2.append(b2Link);

    const b3 = document.createElement('div');
    b3.className = 'ant-bubble';
    const utf8Name = 'Báo cáo.docx';
    const b64 = Buffer.from(utf8Name, 'utf-8').toString('base64url');
    const directFLink = document.createElement('a');
    directFLink.setAttribute('href', `/api/skillHub:download?execId=exec-utf8&f=${b64}`);
    directFLink.textContent = utf8Name;
    const directFilenameLink = document.createElement('a');
    directFilenameLink.setAttribute('href', '/api/skillHub:download?execId=exec-plain&filename=summary.csv');
    directFilenameLink.textContent = 'summary.csv';
    b3.append(directFLink, directFilenameLink);

    chatRoot.append(b1, b2, b3);
    document.body.append(chatRoot);

    const m1Manifest = `<!--skillhub:files ${JSON.stringify([
      { name: 'report.xlsx', downloadUrl: '/api/skillHub:download?execId=run-A&f=cmVwb3J0Lnhsc3g', execId: 'run-A' },
    ])}-->`;
    const m2Manifest = `<!--skillhub:files ${JSON.stringify([
      { name: 'report.xlsx', downloadUrl: '/api/skillHub:download?execId=run-B&f=cmVwb3J0Lnhsc3g', execId: 'run-B' },
    ])}-->`;

    const runtime = createScope(
      chatRoot,
      [],
      [],
      [
        {
          content: {
            content: 'Run A [report.xlsx](sandbox:download/report.xlsx)',
            tool_calls: [{ content: m1Manifest }],
          },
        },
        {
          content: {
            content: 'Run B [report.xlsx](sandbox:download/report.xlsx)',
            tool_calls: [{ content: m2Manifest }],
          },
        },
        { content: { content: 'Direct links' } },
      ],
    );
    vi.spyOn(aiPluginClient, 'getGlobalChatBoxRuntime').mockReturnValue(runtime);
    installAiChatFilePreviewEffect(app);

    fireEvent.click(b1Link);
    expect(openDocumentPreview).toHaveBeenLastCalledWith({
      kind: 'skillHub',
      execId: 'run-A',
      filename: 'report.xlsx',
      displayName: 'report.xlsx',
    });

    fireEvent.click(b2Link);
    expect(openDocumentPreview).toHaveBeenLastCalledWith({
      kind: 'skillHub',
      execId: 'run-B',
      filename: 'report.xlsx',
      displayName: 'report.xlsx',
    });

    fireEvent.click(directFLink);
    expect(openDocumentPreview).toHaveBeenLastCalledWith({
      kind: 'skillHub',
      execId: 'exec-utf8',
      filename: utf8Name,
      displayName: utf8Name,
    });

    fireEvent.click(directFilenameLink);
    expect(openDocumentPreview).toHaveBeenLastCalledWith({
      kind: 'skillHub',
      execId: 'exec-plain',
      filename: 'summary.csv',
      displayName: 'summary.csv',
    });
  });

  it('prevents navigation and warns when plugin-file-preview-auth is disabled or outdated', () => {
    const app = createMockClient();
    vi.spyOn(app.pm, 'get').mockReturnValue(undefined as never);
    const warnSpy = vi.spyOn(message, 'warning').mockImplementation((() => {}) as never);

    const chatRoot = document.createElement('div');
    const link = document.createElement('a');
    link.setAttribute('href', '/files/main/main/attachments/77.pdf');
    link.textContent = 'contract.pdf';
    chatRoot.append(link);
    document.body.append(chatRoot);

    const runtime = createScope(chatRoot, []);
    vi.spyOn(aiPluginClient, 'getGlobalChatBoxRuntime').mockReturnValue(runtime);
    installAiChatFilePreviewEffect(app);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      'Please enable or update Authenticated File Previewer (plugin-file-preview-auth) to preview this document.',
    );
  });

  it('runs full two-plugin V2 integration: click Skill Hub link -> single authenticated fetch -> offline Download exact bytes', async () => {
    const createdUrls: Array<{ url: string; blob: Blob }> = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn((blob: Blob) => {
        const url = `blob:v2-${createdUrls.length + 1}`;
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

    const app = createMockClient();
    app.apiClient.auth.setToken('v2-jwt-token');
    const controller = new DocumentPreviewController(app as never);
    vi.spyOn(app.pm, 'get').mockImplementation(((name: string) => {
      if (name === 'plugin-file-preview-auth') {
        return { openDocumentPreview: controller.openDocumentPreview };
      }
      return undefined;
    }) as never);

    const csvText = 'Quarter,Revenue\nQ1,125000';
    const csvBytes = new TextEncoder().encode(csvText);
    const blob = new Blob([csvBytes], { type: 'text/csv' });
    Object.defineProperty(blob, 'arrayBuffer', {
      value: async () => csvBytes.buffer.slice(csvBytes.byteOffset, csvBytes.byteOffset + csvBytes.byteLength),
    });
    Object.defineProperty(blob, 'slice', { value: () => blob });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="q1-revenue.csv"',
        }),
        blob: async () => blob,
      })
      .mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', fetchMock);

    const chatRoot = document.createElement('div');
    const link = document.createElement('a');
    link.setAttribute('href', '/api/skillHub:download?execId=exec-55&filename=q1-revenue.csv');
    link.textContent = 'q1-revenue.csv';
    chatRoot.append(link);
    document.body.append(chatRoot);

    const runtime = createScope(chatRoot, []);
    vi.spyOn(aiPluginClient, 'getGlobalChatBoxRuntime').mockReturnValue(runtime);
    installAiChatFilePreviewEffect(app);

    fireEvent.click(link);
    expect(await screen.findByText(/Q1,125000/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('skillHub:download?execId=exec-55&f=');
    expect((fetchMock.mock.calls[0][1].headers as Headers).get('Authorization')).toBe('Bearer v2-jwt-token');

    // Go offline (second fetch rejects) and click Download -> must succeed with exact bytes!
    fireEvent.click(screen.getByRole('button', { name: /Download/i }));
    await waitFor(() => expect(createdUrls.length).toBeGreaterThan(0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const downloadedBytes = await readBlobBytes(createdUrls[createdUrls.length - 1].blob);
    expect(new TextDecoder('utf-8').decode(downloadedBytes)).toBe(csvText);

    controller.destroy();
  });
});
