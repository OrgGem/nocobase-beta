import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebhookDispatcher } from '../services/webhook';

const ORIGINAL_URL = process.env.KB_WEBHOOK_URL;
const ORIGINAL_SECRET = process.env.KB_WEBHOOK_SECRET;

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.KB_WEBHOOK_URL;
  else process.env.KB_WEBHOOK_URL = ORIGINAL_URL;
  if (ORIGINAL_SECRET === undefined) delete process.env.KB_WEBHOOK_SECRET;
  else process.env.KB_WEBHOOK_SECRET = ORIGINAL_SECRET;
  vi.unstubAllGlobals();
});

describe('WebhookDispatcher', () => {
  it('is disabled when KB_WEBHOOK_URL is not set', async () => {
    delete process.env.KB_WEBHOOK_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const dispatcher = new WebhookDispatcher();
    const result = await dispatcher.dispatch('document.vectorized', { documentId: 'doc-1' });

    expect(dispatcher.isEnabled()).toBe(false);
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts signed payload and returns true on 2xx', async () => {
    process.env.KB_WEBHOOK_URL = 'https://hooks.example.com/kb';
    process.env.KB_WEBHOOK_SECRET = 's3cret';
    const fetchMock = vi.fn(async () => ({ ok: true } as Response));
    vi.stubGlobal('fetch', fetchMock);

    const dispatcher = new WebhookDispatcher();
    const result = await dispatcher.dispatch('document.vectorized', {
      documentId: 'doc-2',
      knowledgeBaseId: 'kb-1',
      chunkCount: 5,
    });

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hooks.example.com/kb');
    expect(init.method).toBe('POST');
    expect(init.headers['X-KB-Signature']).toEqual(expect.any(String));
    const body = JSON.parse(init.body);
    expect(body.event).toBe('document.vectorized');
    expect(body.documentId).toBe('doc-2');
  });

  it('returns false (never throws) when endpoint fails', async () => {
    process.env.KB_WEBHOOK_URL = 'https://hooks.example.com/kb';
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 } as Response));
    vi.stubGlobal('fetch', fetchMock);

    const dispatcher = new WebhookDispatcher();
    await expect(
      dispatcher.dispatch('document.failed', { documentId: 'doc-3', error: 'boom' }),
    ).resolves.toBe(false);
  });
});