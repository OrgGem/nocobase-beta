import dns from 'dns';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileProcessorError,
  fetchFileAsBase64,
  httpFileUrlFetcher,
  isBlockedAddress,
  type FileProcessorContext,
} from '../services/file-processor';

const PUBLIC_ADDRESS = { address: '93.184.216.34', family: 4 };

function mockDnsLookup(...results: Array<Array<{ address: string; family: number }>>) {
  const spy = vi.spyOn(dns.promises, 'lookup');
  for (const addresses of results) {
    // The overloaded lookup signatures defeat vitest's inferred mock value type.
    spy.mockResolvedValueOnce(addresses as never);
  }
  spy.mockRejectedValue(new Error('unexpected dns lookup'));
  return spy;
}

function mockFetch(...responses: Response[]) {
  const fetchMock = vi.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  fetchMock.mockRejectedValue(new Error('unexpected fetch'));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function okResponse(body: string, contentType = 'text/plain') {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': contentType, 'content-length': String(Buffer.byteLength(body)) },
  });
}

function redirectResponse(location: string, status = 302) {
  return new Response(null, { status, headers: { location } });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('isBlockedAddress', () => {
  it('blocks private, loopback, link-local and reserved IPv4 ranges', () => {
    expect(isBlockedAddress('0.0.0.0')).toBe(true);
    expect(isBlockedAddress('10.0.0.1')).toBe(true);
    expect(isBlockedAddress('100.64.0.1')).toBe(true);
    expect(isBlockedAddress('100.127.255.255')).toBe(true);
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('172.16.0.1')).toBe(true);
    expect(isBlockedAddress('172.31.255.255')).toBe(true);
    expect(isBlockedAddress('192.0.0.1')).toBe(true);
    expect(isBlockedAddress('192.168.0.10')).toBe(true);
    expect(isBlockedAddress('198.18.0.1')).toBe(true);
    expect(isBlockedAddress('198.19.0.1')).toBe(true);
    expect(isBlockedAddress('224.0.0.1')).toBe(true);
    expect(isBlockedAddress('255.255.255.255')).toBe(true);
  });

  it('allows public IPv4 addresses at the range boundaries', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('100.63.255.255')).toBe(false);
    expect(isBlockedAddress('100.128.0.0')).toBe(false);
    expect(isBlockedAddress('172.15.255.255')).toBe(false);
    expect(isBlockedAddress('172.32.0.0')).toBe(false);
    expect(isBlockedAddress('192.167.0.1')).toBe(false);
    expect(isBlockedAddress('198.17.255.255')).toBe(false);
    expect(isBlockedAddress('198.20.0.0')).toBe(false);
  });

  it('blocks unspecified, loopback, ULA, link-local and multicast IPv6 addresses', () => {
    expect(isBlockedAddress('::')).toBe(true);
    expect(isBlockedAddress('::1')).toBe(true);
    expect(isBlockedAddress('fc00::1')).toBe(true);
    expect(isBlockedAddress('fd12:3456::1')).toBe(true);
    expect(isBlockedAddress('fe80::1')).toBe(true);
    expect(isBlockedAddress('febf::1')).toBe(true);
    expect(isBlockedAddress('ff02::1')).toBe(true);
  });

  it('blocks IPv6 forms that embed blocked IPv4 addresses', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::10.0.0.1')).toBe(true);
    expect(isBlockedAddress('64:ff9b::7f00:1')).toBe(true);
  });

  it('allows public IPv6 addresses', () => {
    expect(isBlockedAddress('2001:4860:4860::8888')).toBe(false);
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedAddress('64:ff9b::808:808')).toBe(false);
  });

  it('blocks unparseable input defensively', () => {
    expect(isBlockedAddress('')).toBe(true);
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('1::2::3')).toBe(true);
    expect(isBlockedAddress('1.2.3')).toBe(true);
    expect(isBlockedAddress('1.2.3.256')).toBe(true);
  });
});

describe('fetchFileAsBase64 SSRF protection', () => {
  it('blocks hosts that resolve to private addresses before fetching', async () => {
    const lookupSpy = mockDnsLookup([{ address: '169.254.169.254', family: 4 }]);
    const fetchMock = mockFetch();
    await expect(fetchFileAsBase64('https://evil.example.com/latest/meta-data')).rejects.toMatchObject({
      code: 'blocked_host',
    });
    expect(lookupSpy).toHaveBeenCalledWith('evil.example.com', { all: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks when any resolved address is private', async () => {
    mockDnsLookup([PUBLIC_ADDRESS, { address: '10.0.0.1', family: 4 }]);
    const fetchMock = mockFetch();
    await expect(fetchFileAsBase64('https://dual.example.com/file')).rejects.toMatchObject({
      code: 'blocked_host',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches files from public hosts', async () => {
    mockDnsLookup([PUBLIC_ADDRESS]);
    const fetchMock = mockFetch(okResponse('hello world'));
    const result = await fetchFileAsBase64('https://example.com/doc.txt');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/doc.txt',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(result.mimeType).toBe('text/plain');
    expect(result.filename).toBe('doc.txt');
    expect(result.fileData).toBe(`data:text/plain;base64,${Buffer.from('hello world').toString('base64')}`);
  });

  it('blocks redirects that point at private hosts', async () => {
    const lookupSpy = mockDnsLookup([PUBLIC_ADDRESS], [{ address: '127.0.0.1', family: 4 }]);
    const fetchMock = mockFetch(redirectResponse('http://internal.example/secret'));
    await expect(fetchFileAsBase64('https://example.com/file')).rejects.toMatchObject({ code: 'blocked_host' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lookupSpy).toHaveBeenCalledTimes(2);
  });

  it('follows redirects to allowed public hosts', async () => {
    mockDnsLookup([PUBLIC_ADDRESS], [{ address: '104.16.0.1', family: 4 }]);
    const fetchMock = mockFetch(redirectResponse('https://cdn.example.com/doc.txt', 301), okResponse('payload'));
    const result = await fetchFileAsBase64('https://example.com/doc.txt');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.fileData).toBe(`data:text/plain;base64,${Buffer.from('payload').toString('base64')}`);
    expect(result.filename).toBe('doc.txt');
  });

  it('resolves relative redirect locations against the current URL', async () => {
    mockDnsLookup([PUBLIC_ADDRESS], [PUBLIC_ADDRESS]);
    const fetchMock = mockFetch(redirectResponse('/moved/doc.txt'), okResponse('data'));
    await fetchFileAsBase64('https://example.com/doc.txt');
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://example.com/moved/doc.txt',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('blocks literal private IP hosts without DNS lookup or fetch', async () => {
    const lookupSpy = vi.spyOn(dns.promises, 'lookup');
    const fetchMock = mockFetch();
    await expect(fetchFileAsBase64('http://192.168.0.10/x')).rejects.toMatchObject({ code: 'blocked_host' });
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks bracketed IPv6 loopback literals', async () => {
    const fetchMock = mockFetch();
    await expect(fetchFileAsBase64('http://[::1]/x')).rejects.toMatchObject({ code: 'blocked_host' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops after the redirect limit', async () => {
    const lookupSpy = vi.spyOn(dns.promises, 'lookup');
    lookupSpy.mockResolvedValue([PUBLIC_ADDRESS] as never);
    const fetchMock = vi.fn().mockResolvedValue(redirectResponse('https://example.com/loop'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchFileAsBase64('https://example.com/loop', { maxRedirects: 3 })).rejects.toMatchObject({
      code: 'too_many_redirects',
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('reports DNS failures as fetch_failed', async () => {
    const lookupSpy = vi.spyOn(dns.promises, 'lookup');
    lookupSpy.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const fetchMock = mockFetch();
    await expect(fetchFileAsBase64('https://no-such-host.example/x')).rejects.toMatchObject({
      code: 'fetch_failed',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the existing URL validation errors', async () => {
    await expect(fetchFileAsBase64('not a url')).rejects.toMatchObject({ code: 'invalid_url' });
    await expect(fetchFileAsBase64('ftp://example.com/file')).rejects.toMatchObject({
      code: 'unsupported_protocol',
    });
  });

  it('surfaces blocked hosts through the httpFileUrlFetcher processor', async () => {
    const fetchMock = mockFetch();
    const context = { ctx: {} } as unknown as FileProcessorContext;
    await expect(
      httpFileUrlFetcher.process({ type: 'file_url', file_url: { url: 'http://10.0.0.5/data.pdf' } }, context),
    ).rejects.toBeInstanceOf(FileProcessorError);
    await expect(
      httpFileUrlFetcher.process({ type: 'file_url', file_url: { url: 'http://10.0.0.5/data.pdf' } }, context),
    ).rejects.toMatchObject({ code: 'blocked_host' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
