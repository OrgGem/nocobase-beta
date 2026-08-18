import { describe, expect, it, vi } from 'vitest';
import {
  FileProcessorService,
  base64FileForwarder,
  httpFileUrlFetcher,
  fetchFileAsBase64,
  pdfFileProcessor,
  type PdfToImageRenderer,
} from '../file-processor';

describe('FileProcessorService', () => {
  it('forwards file blocks with base64 data unchanged', async () => {
    const service = new FileProcessorService();
    service.register(base64FileForwarder);

    const block = { type: 'file', file: { file_data: 'data:application/pdf;base64,JVBERi0=' } };
    const result = await service.process(block, { ctx: {} as any });

    expect(result).toEqual(block);
  });

  it('returns the block unchanged when no processor can handle it', async () => {
    const service = new FileProcessorService();
    const block = { type: 'text', text: 'hello' };
    const result = await service.process(block, { ctx: {} as any });

    expect(result).toEqual(block);
  });

  it('allows custom processors to override default behavior', async () => {
    const service = new FileProcessorService();
    service.register(base64FileForwarder);

    const customProcessor = {
      name: 'customFileProcessor',
      canHandle: (block: { type: string }) => block.type === 'file',
      process: vi.fn().mockResolvedValue({ type: 'file', file: { file_data: 'data:text/plain;base64,SGVsbG8=' } }),
    };
    service.register(customProcessor);

    const block = { type: 'file', file: { file_data: 'data:application/pdf;base64,JVBERi0=' } };
    const result = await service.process(block, { ctx: {} as any });

    expect(customProcessor.process).toHaveBeenCalledWith(block, { ctx: {} as any });
    expect(result).toEqual({ type: 'file', file: { file_data: 'data:text/plain;base64,SGVsbG8=' } });
  });

  it('unregister removes a processor by name', () => {
    const service = new FileProcessorService();
    service.register(base64FileForwarder);
    expect(service.list()).toHaveLength(1);

    service.unregister(base64FileForwarder.name);
    expect(service.list()).toHaveLength(0);
  });
});

describe('httpFileUrlFetcher', () => {
  it('fetches a file from an http(s) URL and converts it to a file block', async () => {
    const originalFetch = globalThis.fetch;
    const fileBuffer = Buffer.from('hello world');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'text/plain',
        'content-length': String(fileBuffer.length),
      }),
      arrayBuffer: () =>
        Promise.resolve(fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.length)),
    } as unknown as Response);

    const result = await httpFileUrlFetcher.process(
      { type: 'file_url', file_url: { url: 'https://example.com/hello.txt' } },
      { ctx: {} as any },
    );

    expect(result).toMatchObject({
      type: 'file',
      file: {
        file_data: expect.stringContaining('data:text/plain;base64,'),
        mime_type: 'text/plain',
        filename: 'hello.txt',
      },
    });

    globalThis.fetch = originalFetch;
  });

  it('rejects unsupported protocols', async () => {
    await expect(
      httpFileUrlFetcher.process(
        { type: 'file_url', file_url: { url: 'ftp://example.com/file.txt' } },
        { ctx: {} as any },
      ),
    ).rejects.toThrow('protocol');
  });
});

describe('fetchFileAsBase64', () => {
  it('validates URL protocols', async () => {
    await expect(fetchFileAsBase64('ftp://example.com/file.txt')).rejects.toThrow('protocol');
  });

  it('rejects malformed URLs', async () => {
    await expect(fetchFileAsBase64('not a url')).rejects.toThrow('valid URL');
  });
});

describe('pdfFileProcessor', () => {
  const pdfBuffer = Buffer.from('%PDF-1.4\n1 0 obj\n<<\n>>\nendobj\n', 'binary');
  const pdfDataUrl = `data:application/pdf;base64,${pdfBuffer.toString('base64')}`;

  function createContext(config: { pdfRenderPagesAsImages?: boolean }, renderer?: PdfToImageRenderer | null) {
    const service = new FileProcessorService();
    if (renderer) {
      service.registerPdfRenderer(renderer);
    }
    return {
      ctx: {
        db: {
          getRepository: vi.fn((name: string) => {
            if (name === 'aiApiConfig') {
              return {
                findOne: vi.fn().mockResolvedValue({
                  get: (key: string) => (key === 'pdfRenderPagesAsImages' ? config.pdfRenderPagesAsImages : undefined),
                  pdfRenderPagesAsImages: config.pdfRenderPagesAsImages,
                }),
              };
            }
            return { findOne: vi.fn() };
          }),
        },
        app: {
          pm: {
            get: vi.fn().mockReturnValue({
              fileProcessorService: service,
            }),
          },
        },
        log: { warn: vi.fn() },
      },
    } as any;
  }

  it('forwards a PDF file block when pdfRenderPagesAsImages is disabled', async () => {
    const block = { type: 'file', file: { file_data: pdfDataUrl } } as any;
    const result = await pdfFileProcessor.process(block, createContext({ pdfRenderPagesAsImages: false }));
    expect(result).toBe(block);
  });

  it('forwards a PDF and warns when rendering is enabled but no renderer is registered', async () => {
    const block = { type: 'file', file: { file_data: pdfDataUrl } } as any;
    const context = createContext({ pdfRenderPagesAsImages: true });
    const result = await pdfFileProcessor.process(block, context);

    expect(result).toBe(block);
    expect(context.ctx.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('pdfRenderPagesAsImages is enabled but no PdfToImageRenderer is registered'),
    );
  });

  it('converts a PDF file block into image_url blocks when a renderer is registered', async () => {
    const renderer: PdfToImageRenderer = {
      name: 'mockRenderer',
      render: vi.fn().mockResolvedValue([Buffer.from('page1'), Buffer.from('page2')]),
    };
    const block = { type: 'file', file: { file_data: pdfDataUrl } } as any;
    const result = await pdfFileProcessor.process(block, createContext({ pdfRenderPagesAsImages: true }, renderer));

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect((result as any[])[0]).toMatchObject({ type: 'image_url' });
    expect((result as any[])[0].image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it('does not convert non-PDF file blocks', async () => {
    const block = {
      type: 'file',
      file: { file_data: 'data:text/plain;base64,SGVsbG8=', filename: 'hello.txt' },
    } as any;
    expect(pdfFileProcessor.canHandle(block)).toBe(false);
  });
});
