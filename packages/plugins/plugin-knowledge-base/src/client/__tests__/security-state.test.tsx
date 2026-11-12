// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as ClientV2 from '@nocobase/client-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Infrastructure } from '../components/Infrastructure';
import { KnowledgeBases } from '../components/KnowledgeBases';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

type RequestConfig = {
  url?: string;
  method?: string;
  params?: { filter?: { knowledgeBaseId?: string }; [key: string]: unknown };
  data?: { values?: Record<string, unknown> };
};

type ApiHandler = (url: string, config: RequestConfig) => unknown | Promise<unknown>;

function createApi(handler: ApiHandler) {
  const app = ClientV2.createMockClient();
  const request = vi.spyOn(app.apiClient, 'request').mockImplementation(async (config) => {
    const typedConfig = config as RequestConfig;
    const data = await handler(typedConfig.url ?? '', typedConfig);
    return { data: { data }, status: 200, statusText: 'OK', headers: {}, config: {} } as never;
  });
  vi.spyOn(ClientV2, 'useApp').mockReturnValue(app);
  return { app, request };
}

function deferred<T>() {
  let finish!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    finish = resolve;
  });
  return { promise, resolve: finish };
}

function getSidebarItem(name: string) {
  const label = screen.getAllByText(name).find((element) => element.closest('div[style*="cursor: pointer"]'));
  const item = label?.closest('div[style*="cursor: pointer"]');
  if (!item) throw new Error(`Could not find knowledge base sidebar item: ${name}`);
  return item;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((media: string) => ({
      matches: false,
      media,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe('knowledge base UI security and state isolation', () => {
  const vectorDatabase = {
    id: 'db-1',
    name: 'Primary database',
    provider: 'pgvector',
    connectParams: {
      host: 'pg.internal',
      port: 5432,
      username: 'kb_user',
      password: 'stored-password',
      database: 'kb',
      tableName: 'vectors',
    },
  };

  it('keeps vector credentials out of the edit form and test request, and displays a safe connection error', async () => {
    const { request } = createApi(async (url) => {
      if (url === 'aiVectorDatabase:list') return [vectorDatabase];
      if (url === 'aiVectorDatabase:test') {
        return { success: false, error: 'authentication failed for stored-password at pg.internal' };
      }
      return [];
    });

    render(<Infrastructure />);
    await screen.findByText('Primary database');
    expect(document.body.textContent).not.toContain('stored-password');

    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    const dialog = await screen.findByRole('dialog');
    const password = within(dialog).getByLabelText('Password') as HTMLInputElement;
    expect(password.value).toBe('');
    expect(dialog.textContent).not.toContain('stored-password');

    fireEvent.click(within(dialog).getByRole('button', { name: /Test Connection/ }));
    await screen.findByText('Connection test failed');
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'aiVectorDatabase:test',
          method: 'post',
          data: {
            values: {
              id: 'db-1',
              provider: 'pgvector',
              connectParams: {
                host: 'pg.internal',
                port: 5432,
                username: 'kb_user',
                database: 'kb',
                tableName: 'vectors',
              },
            },
          },
        }),
      ),
    );
    expect(document.body.textContent).not.toContain('authentication failed');
    expect(document.body.textContent).not.toContain('stored-password');
  });

  it('omits a saved credential when unchanged and sends only an intentional replacement or clear', async () => {
    const { request } = createApi(async (url) => (url === 'aiVectorDatabase:list' ? [vectorDatabase] : []));

    render(<Infrastructure />);
    await screen.findByText('Primary database');

    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'aiVectorDatabase:update',
          params: { filterByTk: 'db-1' },
          data: {
            values: {
              name: 'Primary database',
              provider: 'pgvector',
              connectParams: {
                host: 'pg.internal',
                port: 5432,
                username: 'kb_user',
                database: 'kb',
                tableName: 'vectors',
              },
            },
          },
        }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'replacement-password' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'aiVectorDatabase:update',
          data: {
            values: expect.objectContaining({
              connectParams: expect.objectContaining({ password: 'replacement-password' }),
            }),
          },
        }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText('Clear saved credential'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'aiVectorDatabase:update',
          data: { values: expect.objectContaining({ connectParams: expect.objectContaining({ password: null }) }) },
        }),
      ),
    );
    expect(JSON.stringify(request.mock.calls)).not.toContain('stored-password');
  });

  it('does not carry an External RAG key from KB A into empty KB B settings', async () => {
    const knowledgeBases = [
      {
        id: 'kb-a',
        name: 'Alpha',
        type: 'EXTERNAL_RAG',
        accessLevel: 'PUBLIC',
        enabled: true,
        options: { ragProvider: 'external-http', ragApiUrl: 'https://alpha.example.test', ragApiKey: 'alpha-secret' },
      },
      {
        id: 'kb-b',
        name: 'Beta',
        type: 'EXTERNAL_RAG',
        accessLevel: 'PUBLIC',
        enabled: true,
        options: { ragProvider: 'external-http', ragApiUrl: 'https://beta.example.test' },
      },
    ];
    const { request } = createApi(async (url) => {
      if (url === 'aiKnowledgeBase:list') return knowledgeBases;
      if (
        url === 'aiVectorStore:list' ||
        url === 'ai:listLLMServices' ||
        url === 'roles:list' ||
        url === 'aiEmployees:list'
      ) {
        return [];
      }
      if (url === 'aiKnowledgeBaseDoc:list') return [];
      return [];
    });

    render(<KnowledgeBases />);
    await screen.findAllByText('Alpha');
    fireEvent.click(screen.getByText('Settings'));
    let apiKey = (await screen.findByLabelText('API Key')) as HTMLInputElement;
    await waitFor(() => expect(apiKey.value).toBe(''));
    expect(screen.queryByText('alpha-secret')).toBeNull();

    fireEvent.click(getSidebarItem('Beta'));
    apiKey = (await screen.findByLabelText('API Key')) as HTMLInputElement;
    await waitFor(() => expect(apiKey.value).toBe(''));
    expect(screen.queryByLabelText('Clear saved credential')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'aiKnowledgeBase:update',
          params: { filterByTk: 'kb-b' },
          data: {
            values: expect.objectContaining({ options: expect.not.objectContaining({ ragApiKey: 'alpha-secret' }) }),
          },
        }),
      ),
    );
    expect(JSON.stringify(request.mock.calls)).not.toContain('alpha-secret');
  });

  it('does not let a deferred KB A settings save clear KB B credentials', async () => {
    const updateA = deferred<unknown>();
    let updateCalls = 0;
    const knowledgeBases = [
      {
        id: 'kb-a',
        name: 'Alpha',
        type: 'EXTERNAL_RAG',
        accessLevel: 'PUBLIC',
        enabled: true,
        options: { ragProvider: 'external-http', ragApiUrl: 'https://alpha.example.test', hasRagApiKey: true },
      },
      {
        id: 'kb-b',
        name: 'Beta',
        type: 'EXTERNAL_RAG',
        accessLevel: 'PUBLIC',
        enabled: true,
        options: { ragProvider: 'external-http', ragApiUrl: 'https://beta.example.test' },
      },
    ];
    const { request } = createApi(async (url) => {
      if (url === 'aiKnowledgeBase:list') return knowledgeBases;
      if (
        url === 'aiVectorStore:list' ||
        url === 'ai:listLLMServices' ||
        url === 'roles:list' ||
        url === 'aiEmployees:list'
      ) {
        return [];
      }
      if (url === 'aiKnowledgeBaseDoc:list') return [];
      if (url === 'aiKnowledgeBase:update') return ++updateCalls === 1 ? updateA.promise : { id: 'kb-b' };
      return [];
    });

    render(<KnowledgeBases />);
    await screen.findAllByText('Alpha');
    fireEvent.click(screen.getByRole('tab', { name: /Settings/ }));
    const apiKeyA = (await screen.findByLabelText('API Key')) as HTMLInputElement;
    fireEvent.change(apiKeyA, { target: { value: 'alpha-replacement' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(updateCalls).toBe(1));

    fireEvent.click(getSidebarItem('Beta'));
    const apiKeyB = (await screen.findByLabelText('API Key')) as HTMLInputElement;
    await waitFor(() => expect(apiKeyB.value).toBe(''));
    fireEvent.change(apiKeyB, { target: { value: 'beta-new-key' } });
    updateA.resolve({ id: 'kb-a' });
    await waitFor(() => expect(apiKeyB.value).toBe('beta-new-key'));

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'aiKnowledgeBase:update',
          params: { filterByTk: 'kb-b' },
          data: {
            values: expect.objectContaining({ options: expect.objectContaining({ ragApiKey: 'beta-new-key' }) }),
          },
        }),
      ),
    );
    const updates = request.mock.calls
      .map(([config]) => config as RequestConfig)
      .filter((config) => config.url === 'aiKnowledgeBase:update');
    expect(updates).toHaveLength(2);
    expect(JSON.stringify(updates[1])).not.toContain('alpha-replacement');
  });

  it('uploads against the original KB after switching while the file request is pending', async () => {
    const upload = deferred<{ data: { data: { id: string; filename: string } } }>();
    const knowledgeBases = [
      { id: 'kb-a', name: 'Alpha', type: 'LOCAL', accessLevel: 'PUBLIC', enabled: true },
      { id: 'kb-b', name: 'Beta', type: 'LOCAL', accessLevel: 'PUBLIC', enabled: true },
    ];
    const { app, request } = createApi(async (url, config) => {
      if (url === 'aiKnowledgeBase:list') return knowledgeBases;
      if (
        url === 'aiVectorStore:list' ||
        url === 'ai:listLLMServices' ||
        url === 'roles:list' ||
        url === 'aiEmployees:list'
      ) {
        return [];
      }
      if (url === 'aiKnowledgeBaseDoc:list' && config.params?.filter?.knowledgeBaseId === 'kb-b') return [];
      if (url === 'aiKnowledgeBaseDoc:list') return [];
      return [];
    });
    vi.spyOn(app.apiClient.axios, 'post').mockReturnValue(upload.promise as never);

    render(<KnowledgeBases />);
    await screen.findAllByText('Alpha');
    const input = document.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('Knowledge base file picker was not rendered');
    fireEvent.change(input, { target: { files: [new File(['content'], 'alpha-upload.txt', { type: 'text/plain' })] } });
    await waitFor(() => expect(app.apiClient.axios.post).toHaveBeenCalled());

    fireEvent.click(getSidebarItem('Beta'));
    await screen.findAllByText('Beta');
    upload.resolve({ data: { data: { id: 'file-a', filename: 'alpha-upload.txt' } } });

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'aiKnowledgeBaseDoc:create',
          method: 'post',
          data: {
            values: {
              knowledgeBaseId: 'kb-a',
              fileId: 'file-a',
              filename: 'alpha-upload.txt',
              status: 'pending',
            },
          },
        }),
      ),
    );
    expect(screen.queryByText('alpha-upload.txt')).toBeNull();
    expect(
      request.mock.calls.filter(([config]) => (config as RequestConfig).url === 'aiKnowledgeBaseDoc:list'),
    ).toHaveLength(2);
  });

  it('resets document selection on KB switch and sends only visible B document IDs to bulk delete', async () => {
    const alphaDocuments = Array.from({ length: 11 }, (_, index) => ({
      id: `doc-a-${index + 1}`,
      filename: `alpha-doc-${index + 1}.txt`,
      status: 'failed',
    }));
    const knowledgeBases = [
      { id: 'kb-a', name: 'Alpha', type: 'LOCAL', accessLevel: 'PUBLIC', enabled: true },
      { id: 'kb-b', name: 'Beta', type: 'LOCAL', accessLevel: 'PUBLIC', enabled: true },
    ];
    const { request } = createApi(async (url, config) => {
      if (url === 'aiKnowledgeBase:list') return knowledgeBases;
      if (
        url === 'aiVectorStore:list' ||
        url === 'ai:listLLMServices' ||
        url === 'roles:list' ||
        url === 'aiEmployees:list'
      ) {
        return [];
      }
      if (url === 'aiKnowledgeBaseDoc:list' && config.params?.filter?.knowledgeBaseId === 'kb-a') {
        return alphaDocuments;
      }
      if (url === 'aiKnowledgeBaseDoc:list') {
        return [{ id: 'doc-b', filename: 'beta-doc.txt', status: 'failed' }];
      }
      return [];
    });

    render(<KnowledgeBases />);
    await screen.findByText('alpha-doc-1.txt');
    const secondPage = document.querySelector('.ant-pagination-item-2 a');
    if (!(secondPage instanceof HTMLAnchorElement)) throw new Error('Second document page was not rendered');
    fireEvent.click(secondPage);
    await screen.findByText('alpha-doc-11.txt');
    const alphaRow = screen.getByText('alpha-doc-11.txt').closest('tr');
    if (!alphaRow) throw new Error('Alpha page-two document row was not rendered');
    fireEvent.click(within(alphaRow).getByRole('checkbox'));
    await screen.findByText('1 selected');

    fireEvent.click(getSidebarItem('Beta'));
    await screen.findByText('beta-doc.txt');
    expect(screen.queryByText('1 selected')).toBeNull();
    const betaRow = screen.getByText('beta-doc.txt').closest('tr');
    if (!betaRow) throw new Error('Beta document row was not rendered');
    fireEvent.click(within(betaRow).getByRole('checkbox'));
    await screen.findByText('1 selected');

    const selectedToolbar = screen.getByText('1 selected').closest('.ant-space');
    if (!(selectedToolbar instanceof HTMLElement)) throw new Error('Bulk document actions were not rendered');
    const deleteButton = within(selectedToolbar).getByRole('button', { name: /Delete/ });
    fireEvent.click(deleteButton);
    await screen.findByText((content) => content.startsWith('Delete 1 document(s)?'));
    fireEvent.click(screen.getByRole('button', { name: /Yes|OK/ }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'aiKnowledgeBaseDoc:bulkDestroy',
          method: 'post',
          data: { values: { knowledgeBaseId: 'kb-b', documentIds: ['doc-b'] } },
        }),
      ),
    );
  });

  it('does not let a pending KB A bulk-delete response clear KB B selection', async () => {
    const deleteA = deferred<unknown>();
    const knowledgeBases = [
      { id: 'kb-a', name: 'Alpha', type: 'LOCAL', accessLevel: 'PUBLIC', enabled: true },
      { id: 'kb-b', name: 'Beta', type: 'LOCAL', accessLevel: 'PUBLIC', enabled: true },
    ];
    const { request } = createApi(async (url, config) => {
      if (url === 'aiKnowledgeBase:list') return knowledgeBases;
      if (
        url === 'aiVectorStore:list' ||
        url === 'ai:listLLMServices' ||
        url === 'roles:list' ||
        url === 'aiEmployees:list'
      ) {
        return [];
      }
      if (url === 'aiKnowledgeBaseDoc:list' && config.params?.filter?.knowledgeBaseId === 'kb-a') {
        return [{ id: 'doc-a', filename: 'alpha-doc.txt', status: 'failed' }];
      }
      if (url === 'aiKnowledgeBaseDoc:list') {
        return [{ id: 'doc-b', filename: 'beta-doc.txt', status: 'failed' }];
      }
      if (url === 'aiKnowledgeBaseDoc:bulkDestroy') return deleteA.promise;
      return [];
    });

    render(<KnowledgeBases />);
    await screen.findByText('alpha-doc.txt');
    const alphaRow = screen.getByText('alpha-doc.txt').closest('tr');
    if (!alphaRow) throw new Error('Alpha document row was not rendered');
    fireEvent.click(within(alphaRow).getByRole('checkbox'));
    await screen.findByText('1 selected');
    const alphaToolbar = screen.getByText('1 selected').closest('.ant-space');
    if (!(alphaToolbar instanceof HTMLElement)) throw new Error('Alpha bulk document actions were not rendered');
    fireEvent.click(within(alphaToolbar).getByRole('button', { name: /Delete/ }));
    await screen.findByText((content) => content.startsWith('Delete 1 document(s)?'));
    fireEvent.click(screen.getByRole('button', { name: /Yes|OK/ }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'aiKnowledgeBaseDoc:bulkDestroy',
          method: 'post',
          data: { values: { knowledgeBaseId: 'kb-a', documentIds: ['doc-a'] } },
        }),
      ),
    );

    fireEvent.click(getSidebarItem('Beta'));
    await screen.findByText('beta-doc.txt');
    const betaRow = screen.getByText('beta-doc.txt').closest('tr');
    if (!betaRow) throw new Error('Beta document row was not rendered');
    fireEvent.click(within(betaRow).getByRole('checkbox'));
    await screen.findByText('1 selected');

    deleteA.resolve([]);
    await waitFor(() => expect(screen.getByText('1 selected')).toBeTruthy());
    expect(screen.getByText('beta-doc.txt')).toBeTruthy();
  });

  it('does not let late search results from KB A replace KB B results', async () => {
    const searchA = deferred<unknown>();
    const knowledgeBases = [
      { id: 'kb-a', name: 'Alpha', type: 'LOCAL', accessLevel: 'PUBLIC', enabled: true },
      { id: 'kb-b', name: 'Beta', type: 'LOCAL', accessLevel: 'PUBLIC', enabled: true },
    ];
    const { request } = createApi(async (url, config) => {
      if (url === 'aiKnowledgeBase:list') return knowledgeBases;
      if (
        url === 'aiVectorStore:list' ||
        url === 'ai:listLLMServices' ||
        url === 'roles:list' ||
        url === 'aiEmployees:list'
      ) {
        return [];
      }
      if (url === 'aiKnowledgeBaseDoc:list') return [];
      if (url === 'aiKnowledgeBase:search') {
        const values = config.data?.values ?? {};
        const knowledgeBaseIds = values.knowledgeBaseIds as string[] | undefined;
        return knowledgeBaseIds?.[0] === 'kb-a'
          ? searchA.promise
          : { data: [{ id: 'result-b', content: 'Beta search result', score: 0.9 }] };
      }
      return [];
    });

    render(<KnowledgeBases />);
    await screen.findAllByText('Alpha');
    fireEvent.click(screen.getByRole('tab', { name: /Search/ }));
    fireEvent.change(screen.getByPlaceholderText('Search this knowledge base...'), {
      target: { value: 'alpha query' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    await waitFor(() =>
      expect(
        request.mock.calls.some(([config]) => {
          const call = config as RequestConfig;
          return (
            call.url === 'aiKnowledgeBase:search' &&
            (call.data?.values?.knowledgeBaseIds as string[] | undefined)?.[0] === 'kb-a'
          );
        }),
      ).toBe(true),
    );

    fireEvent.click(getSidebarItem('Beta'));
    fireEvent.change(screen.getByPlaceholderText('Search this knowledge base...'), { target: { value: 'beta query' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    await screen.findByText('Beta search result');
    searchA.resolve({ data: [{ id: 'result-a', content: 'Alpha stale result', score: 0.9 }] });

    await waitFor(() => expect(screen.queryByText('Alpha stale result')).toBeNull());
    expect(screen.getByText('Beta search result')).toBeTruthy();
    expect(
      request.mock.calls.some(([config]) => {
        const call = config as RequestConfig;
        return (
          call.url === 'aiKnowledgeBase:search' &&
          (call.data?.values?.knowledgeBaseIds as string[] | undefined)?.[0] === 'kb-b'
        );
      }),
    ).toBe(true);
  });

  it('does not let an old A documents response repaint A after switching A to B and back to A', async () => {
    const firstA = deferred<unknown>();
    let aCalls = 0;
    const knowledgeBases = [
      { id: 'kb-a', name: 'Alpha', type: 'LOCAL', accessLevel: 'PUBLIC', enabled: true },
      { id: 'kb-b', name: 'Beta', type: 'LOCAL', accessLevel: 'PUBLIC', enabled: true },
    ];
    const { request } = createApi(async (url, config) => {
      if (url === 'aiKnowledgeBase:list') return knowledgeBases;
      if (
        url === 'aiVectorStore:list' ||
        url === 'ai:listLLMServices' ||
        url === 'roles:list' ||
        url === 'aiEmployees:list'
      ) {
        return [];
      }
      if (url === 'aiKnowledgeBaseDoc:list') {
        const kbId = config.params?.filter?.knowledgeBaseId;
        if (kbId === 'kb-a' && ++aCalls === 1) return firstA.promise;
        if (kbId === 'kb-b') return [{ id: 'doc-b', filename: 'beta-current.txt', status: 'success' }];
        if (kbId === 'kb-a') return [{ id: 'doc-a-current', filename: 'alpha-current.txt', status: 'success' }];
      }
      return [];
    });

    render(<KnowledgeBases />);
    await screen.findAllByText('Alpha');
    fireEvent.click(getSidebarItem('Beta'));
    await screen.findByText('beta-current.txt');
    fireEvent.click(getSidebarItem('Alpha'));
    await screen.findByText('alpha-current.txt');

    firstA.resolve([{ id: 'doc-a-old', filename: 'alpha-stale.txt', status: 'failed' }]);
    await waitFor(() => expect(screen.queryByText('alpha-stale.txt')).toBeNull());
    expect(screen.getByText('alpha-current.txt')).toBeTruthy();
    expect(request).toHaveBeenCalled();
  });
});
