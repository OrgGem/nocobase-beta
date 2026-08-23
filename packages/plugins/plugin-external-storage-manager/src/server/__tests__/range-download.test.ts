import { vi } from 'vitest';
import { createExtStorageActions, parseRangeHeader } from '../actions/ext-storage';
import type { IStorageAdapter } from '../adapters/types';

describe('parseRangeHeader', () => {
  it('parses a closed range', () => {
    expect(parseRangeHeader('bytes=0-99')).toEqual({ start: 0, end: 99 });
    expect(parseRangeHeader('bytes=100-199')).toEqual({ start: 100, end: 199 });
  });

  it('parses an open-ended range', () => {
    expect(parseRangeHeader('bytes=100-')).toEqual({ start: 100, end: undefined });
  });

  it('resolves a suffix range against the total size', () => {
    expect(parseRangeHeader('bytes=-500', 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRangeHeader('bytes=-999999', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('returns null for absent, malformed, or multi-range headers', () => {
    expect(parseRangeHeader(undefined)).toBeNull();
    expect(parseRangeHeader('')).toBeNull();
    expect(parseRangeHeader('bytes=')).toBeNull();
    expect(parseRangeHeader('items=0-5')).toBeNull();
    expect(parseRangeHeader('bytes=0-1,5-9')).toBeNull();
    expect(parseRangeHeader('bytes=abc-def')).toBeNull();
    expect(parseRangeHeader('bytes=50-10')).toBeNull();
  });

  it('returns null for a suffix range when total size is unknown', () => {
    expect(parseRangeHeader('bytes=-500')).toBeNull();
  });

  it('marks unsatisfiable ranges with start = -1', () => {
    expect(parseRangeHeader('bytes=2000-', 1000)).toEqual({ start: -1 });
  });
});

function createDownloadContext(statSize?: number) {
  const directoryValues: Record<string, string | number | boolean> = {
    id: 1,
    name: 'docs',
    rootPath: '/root',
    enabled: true,
  };
  const directory = {
    get(key: string) {
      return directoryValues[key];
    },
  };
  const headers: Record<string, string> = {};
  const getStream = vi.fn().mockImplementation(async (_path: string, range?: { start: number; end?: number }) => {
    const total = 1000;
    if (range) {
      const end = Math.min(range.end ?? total - 1, total - 1);
      return {
        stream: 'fake-stream',
        contentType: 'video/mp4',
        size: end - range.start + 1,
        contentRange: `bytes ${range.start}-${end}/${total}`,
      };
    }
    return { stream: 'fake-stream', contentType: 'video/mp4', size: total };
  });
  const stat = vi.fn().mockResolvedValue({ name: 'video.mp4', type: 'file', size: statSize ?? 1000, modifiedAt: 0 });
  const adapter = { getStream, stat } as unknown as IStorageAdapter;
  const actions = createExtStorageActions(async () => adapter);
  const ctx = {
    action: { params: { directoryId: 1, path: '/video.mp4', mode: 'inline' } },
    request: { query: {}, body: {}, headers: {} as Record<string, string> },
    headers: {} as Record<string, string>,
    get(key: string) {
      return headers[key];
    },
    set(key: string, value: string) {
      headers[key] = value;
    },
    state: {},
    app: {},
    can: () => ({ params: { filter: {} } }),
    db: { getRepository: () => ({ findOne: async () => directory }) },
    logger: { error: vi.fn(), warn: vi.fn() },
    throw: (status: number, message: string) => {
      const error = new Error(message) as Error & { status: number };
      error.status = status;
      throw error;
    },
  };
  return { actions, ctx, headers, getStream, stat };
}

describe('extStorage:download range support', () => {
  it('serves 200 with Accept-Ranges when no Range header is present', async () => {
    const { actions, ctx, headers, getStream } = createDownloadContext();
    await actions.download(ctx);
    expect(ctx.status).toBeUndefined();
    expect(headers['Accept-Ranges']).toEqual('bytes');
    expect(headers['Content-Length']).toEqual('1000');
    expect(getStream).toHaveBeenCalledWith('/root/video.mp4', undefined);
  });

  it('serves 206 with Content-Range for a closed range', async () => {
    const { actions, ctx, headers, getStream } = createDownloadContext();
    (ctx.request.headers as Record<string, string>).range = 'bytes=100-199';
    await actions.download(ctx);
    expect(ctx.status).toEqual(206);
    expect(headers['Content-Range']).toEqual('bytes 100-199/1000');
    expect(headers['Content-Length']).toEqual('100');
    expect(getStream).toHaveBeenCalledWith('/root/video.mp4', { start: 100, end: 199 });
  });

  it('resolves suffix ranges via stat before streaming once', async () => {
    const { actions, ctx, headers, getStream, stat } = createDownloadContext();
    (ctx.request.headers as Record<string, string>).range = 'bytes=-200';
    await actions.download(ctx);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(ctx.status).toEqual(206);
    expect(headers['Content-Range']).toEqual('bytes 800-999/1000');
    expect(getStream).toHaveBeenCalledTimes(1);
    expect(getStream).toHaveBeenCalledWith('/root/video.mp4', { start: 800, end: 999 });
  });

  it('responds 416 for unsatisfiable ranges', async () => {
    const { actions, ctx, getStream } = createDownloadContext();
    (ctx.request.headers as Record<string, string>).range = 'bytes=5000-';
    await expect(actions.download(ctx)).rejects.toMatchObject({ status: 416 });
    expect(getStream).not.toHaveBeenCalled();
  });

  it('ignores malformed range headers and serves the full file', async () => {
    const { actions, ctx, getStream } = createDownloadContext();
    (ctx.request.headers as Record<string, string>).range = 'bytes=zzz-yyy';
    await actions.download(ctx);
    expect(ctx.status).toBeUndefined();
    expect(getStream).toHaveBeenCalledWith('/root/video.mp4', undefined);
  });

  it('emits RFC 5987 Content-Disposition for unicode filenames', async () => {
    const { actions, ctx, headers } = createDownloadContext();
    (ctx.action.params as Record<string, unknown>).path = '/báo cáo.pdf';
    await actions.download(ctx);
    expect(headers['Content-Disposition']).toContain(`filename*=UTF-8''b%C3%A1o%20c%C3%A1o.pdf`);
  });
});
