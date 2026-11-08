/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import dns from 'dns';
import http, { type IncomingMessage, type RequestOptions, type Server } from 'http';
import type { AddressInfo } from 'net';
import { gzipSync } from 'zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFileAsBase64 } from '../services/file-processor';

const PUBLIC_ADDRESS = { address: '93.184.216.34', family: 4 };
const servers: Server[] = [];
const pinnedAddresses: dns.LookupAddress[][] = [];

beforeEach(() => {
  pinnedAddresses.length = 0;
  vi.spyOn(dns.promises, 'lookup').mockResolvedValue([PUBLIC_ADDRESS] as never);
  // A second DNS lookup would rebind to loopback. Only the validated snapshot may reach the transport.
  vi.spyOn(dns, 'lookup').mockImplementation(((
    _host: string,
    _options: dns.LookupAllOptions,
    callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
  ) => {
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
  }) as typeof dns.lookup);
  const realGet = http.get;
  vi.spyOn(http, 'get').mockImplementation(((
    url: URL,
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => {
    const validatedLookup = options.lookup;
    return realGet(
      url,
      {
        ...options,
        lookup: (hostname, lookupOptions, done) => {
          if (!validatedLookup) throw new Error('The request must pin its DNS lookup');
          validatedLookup(hostname, lookupOptions, (error, addresses) => {
            pinnedAddresses.push(addresses);
            // Map the validated public endpoint onto our test server; no external connections are made.
            done(
              error,
              addresses.map((address) => ({ ...address, address: '127.0.0.1', family: 4 })),
            );
          });
        },
      },
      callback,
    );
  }) as typeof http.get);
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.restoreAllMocks();
});

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Server.listen resolves its bind address too; only track outbound DNS lookups after startup.
  vi.mocked(dns.lookup).mockClear();
  return `http://files.example:${(server.address() as AddressInfo).port}`;
}

describe('file download transport', () => {
  it('uses the checked DNS snapshot while retaining the original Host header', async () => {
    let host: string | undefined;
    const url = await serve((request, response) => {
      host = request.headers.host;
      response.setHeader('content-type', 'text/plain');
      response.end('public-file');
    });
    const result = await fetchFileAsBase64(`${url}/file.txt`);
    expect(result.fileData).toBe(`data:text/plain;base64,${Buffer.from('public-file').toString('base64')}`);
    expect(host).toBe(new URL(url).host);
    expect(pinnedAddresses).toEqual([[PUBLIC_ADDRESS]]);
    expect(dns.promises.lookup).toHaveBeenCalledTimes(1);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it('validates and pins a new snapshot for every redirect hop', async () => {
    const nextAddress = { address: '104.16.0.1', family: 4 };
    vi.mocked(dns.promises.lookup)
      .mockResolvedValueOnce([PUBLIC_ADDRESS] as never)
      .mockResolvedValueOnce([nextAddress] as never);
    const url = await serve((request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, { location: '/final' });
        response.end();
      } else response.end('final');
    });
    await fetchFileAsBase64(`${url}/start`);
    expect(pinnedAddresses).toEqual([[PUBLIC_ADDRESS], [nextAddress]]);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it('closes a chunked download as soon as its body exceeds the cap', async () => {
    let sent = 0;
    let ended = false;
    let closed = false;
    const url = await serve((_request, response) => {
      const timer = setInterval(() => {
        sent += 1024;
        response.write(Buffer.alloc(1024));
        if (sent === 100 * 1024) {
          ended = true;
          response.end();
        }
      }, 5);
      response.on('close', () => {
        closed = true;
        clearInterval(timer);
      });
    });
    await expect(fetchFileAsBase64(url, { maxSizeBytes: 2048 })).rejects.toMatchObject({ code: 'file_too_large' });
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(ended).toBe(false);
    expect(sent).toBeLessThan(100 * 1024);
  });

  it('accepts a body exactly at the limit', async () => {
    const url = await serve((_request, response) => response.end('1234'));
    const result = await fetchFileAsBase64(url, { maxSizeBytes: 4 });
    expect(result.fileData).toBe('data:application/octet-stream;base64,MTIzNA==');
  });

  it('rejects an oversized Content-Length before consuming the body', async () => {
    let closed = false;
    const url = await serve((_request, response) => {
      response.writeHead(200, { 'content-length': '100000' });
      response.flushHeaders();
      response.on('close', () => {
        closed = true;
      });
    });
    await expect(fetchFileAsBase64(url, { maxSizeBytes: 4 })).rejects.toMatchObject({ code: 'file_too_large' });
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it('applies the cap to decompressed bytes, not just the compressed Content-Length', async () => {
    const compressed = gzipSync(Buffer.alloc(65536, 'x'));
    const url = await serve((_request, response) => {
      response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': compressed.length });
      response.end(compressed);
    });
    expect(compressed.length).toBeLessThan(1024);
    await expect(fetchFileAsBase64(url, { maxSizeBytes: 1024 })).rejects.toMatchObject({ code: 'file_too_large' });
  });

  it('aborts a stalled response body at the request timeout', async () => {
    let closed = false;
    const url = await serve((_request, response) => {
      response.writeHead(200);
      response.flushHeaders();
      response.on('close', () => {
        closed = true;
      });
    });
    await expect(fetchFileAsBase64(url, { timeoutMs: 100 })).rejects.toThrow();
    await vi.waitFor(() => expect(closed).toBe(true));
  });
});
