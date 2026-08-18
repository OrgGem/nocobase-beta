import type { Context } from '@nocobase/actions';
import dns from 'dns';
import { isIP } from 'net';
import { basename } from 'path';
import { getAiApiConfig } from '../utils/request-cache';

export interface FileContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface FileProcessorContext {
  ctx: Context;
}

export interface FileProcessor {
  name: string;
  canHandle(block: FileContentBlock): boolean;
  process(block: FileContentBlock, context: FileProcessorContext): Promise<FileContentBlock | FileContentBlock[]>;
}

export interface PdfToImageRenderer {
  name: string;
  /**
   * Render each page of a PDF into a PNG image buffer.
   * @param buffer Raw PDF bytes.
   * @returns Array of PNG buffers, one per page.
   */
  render(buffer: Buffer): Promise<Buffer[]>;
}

export type FileProcessorErrorCode =
  | 'invalid_url'
  | 'unsupported_protocol'
  | 'blocked_host'
  | 'fetch_failed'
  | 'file_too_large'
  | 'content_type_not_allowed'
  | 'too_many_redirects'
  | 'missing_url';

export class FileProcessorError extends Error {
  constructor(
    readonly code: FileProcessorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FileProcessorError';
  }
}

export interface FetchFileOptions {
  maxSizeBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  allowedProtocols?: string[];
  allowedContentTypes?: string[];
}

const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class FileProcessorService {
  private processors: FileProcessor[] = [];
  private pdfRenderer: PdfToImageRenderer | null = null;

  register(processor: FileProcessor): void {
    this.unregister(processor.name);
    this.processors.push(processor);
  }

  unregister(name: string): void {
    this.processors = this.processors.filter((p) => p.name !== name);
  }

  async process(
    block: FileContentBlock,
    context: FileProcessorContext,
  ): Promise<FileContentBlock | FileContentBlock[]> {
    // Search from the end so the most recently registered processor wins.
    // This makes it easy for a custom plugin to override a default processor.
    const processor = [...this.processors].reverse().find((p) => p.canHandle(block));
    if (!processor) {
      return block;
    }
    return processor.process(block, context);
  }

  list(): ReadonlyArray<FileProcessor> {
    return [...this.processors];
  }

  /**
   * Register a renderer used to convert PDF pages into PNG images when
   * `pdfRenderPagesAsImages` is enabled in the AI API config.
   */
  registerPdfRenderer(renderer: PdfToImageRenderer): void {
    this.pdfRenderer = renderer;
  }

  unregisterPdfRenderer(): void {
    this.pdfRenderer = null;
  }

  getPdfRenderer(): PdfToImageRenderer | null {
    return this.pdfRenderer;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractFilename(url: string, contentDisposition: string | null): string | undefined {
  if (contentDisposition) {
    const match = contentDisposition.match(/filename="?([^"]+)"?/);
    if (match) return match[1];
  }
  try {
    const pathname = new URL(url).pathname;
    if (pathname) return basename(pathname);
  } catch {
    // ignore malformed URL
  }
  return undefined;
}

function parseIpv4Octets(ip: string): number[] | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    octets.push(value);
  }
  return octets;
}

function isBlockedIpv4(ip: string): boolean {
  const octets = parseIpv4Octets(ip);
  if (!octets) return true;
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this" network
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function parseHexGroup(group: string): number | undefined {
  if (group.length < 1 || group.length > 4 || !/^[0-9a-fA-F]+$/.test(group)) return undefined;
  return parseInt(group, 16);
}

function expandIpv6(input: string): number[] | undefined {
  let address = input;
  const zoneIndex = address.indexOf('%');
  if (zoneIndex !== -1) address = address.slice(0, zoneIndex);
  if (!address) return undefined;

  // Rewrite an embedded IPv4 suffix (e.g. ::ffff:127.0.0.1) as two hex groups.
  const lastColon = address.lastIndexOf(':');
  if (lastColon !== -1 && address.includes('.', lastColon)) {
    const octets = parseIpv4Octets(address.slice(lastColon + 1));
    if (!octets) return undefined;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    address = `${address.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const groups: number[] = [];
  const doubleColonIndex = address.indexOf('::');
  if (doubleColonIndex !== -1) {
    if (address.indexOf('::', doubleColonIndex + 1) !== -1) return undefined;
    const head = address.slice(0, doubleColonIndex);
    const tail = address.slice(doubleColonIndex + 2);
    const headGroups = head === '' ? [] : head.split(':');
    const tailGroups = tail === '' ? [] : tail.split(':');
    const fillCount = 8 - headGroups.length - tailGroups.length;
    if (fillCount < 1) return undefined;
    const allGroups = [...headGroups];
    for (let i = 0; i < fillCount; i += 1) allGroups.push('0');
    allGroups.push(...tailGroups);
    for (const group of allGroups) {
      const parsed = parseHexGroup(group);
      if (parsed === undefined) return undefined;
      groups.push(parsed);
    }
  } else {
    for (const group of address.split(':')) {
      const parsed = parseHexGroup(group);
      if (parsed === undefined) return undefined;
      groups.push(parsed);
    }
  }

  return groups.length === 8 ? groups : undefined;
}

function isBlockedIpv6(ip: string): boolean {
  const groups = expandIpv6(ip);
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

  if (groups.every((group) => group === 0)) return true; // :: unspecified
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return true; // ::1 loopback
  }

  // Embedded IPv4 forms: IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d),
  // and NAT64 (64:ff9b::a.b.c.d) — judge by the embedded IPv4 address.
  const isIpv4Mapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff;
  const isIpv4Compatible = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
  const isNat64 = g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
  if (isIpv4Mapped || isIpv4Compatible || isNat64) {
    const embedded = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    return isBlockedIpv4(embedded);
  }

  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * Returns true when an IP literal must not be fetched: private, loopback,
 * link-local, and other reserved ranges for both IPv4 and IPv6 (including IPv6
 * forms that embed an IPv4 address). Unparseable input is blocked defensively.
 */
export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return true;
}

async function assertHostAllowed(hostname: string): Promise<void> {
  if (isIP(hostname) !== 0) {
    if (isBlockedAddress(hostname)) {
      throw new FileProcessorError('blocked_host', `Host '${hostname}' is a blocked address.`);
    }
    return;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.promises.lookup(hostname, { all: true });
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : String(error);
    throw new FileProcessorError('fetch_failed', `Could not resolve host '${hostname}': ${message}`);
  }

  if (!addresses.length) {
    throw new FileProcessorError('fetch_failed', `Could not resolve host '${hostname}'.`);
  }

  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new FileProcessorError('blocked_host', `Host '${hostname}' resolves to blocked address '${address}'.`);
    }
  }
}

async function fetchWithSsrfGuard(
  initialUrl: string,
  options: { allowedProtocols: Set<string>; maxRedirects: number; signal: AbortSignal },
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = initialUrl;
  for (let hop = 0; ; hop += 1) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      throw new FileProcessorError('invalid_url', `File URL '${currentUrl}' is not a valid URL.`);
    }

    if (!options.allowedProtocols.has(parsed.protocol)) {
      throw new FileProcessorError('unsupported_protocol', `File URL protocol '${parsed.protocol}' is not allowed.`);
    }

    // SSRF guard: resolve and validate the host before connecting. A malicious DNS
    // server could still rebind between this check and the fetch; closing that gap
    // fully would require pinning the resolved address into the connection.
    const hostname =
      parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']') ? parsed.hostname.slice(1, -1) : parsed.hostname;
    await assertHostAllowed(hostname);

    const response = await fetch(currentUrl, { signal: options.signal, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, finalUrl: currentUrl };
    }

    if (hop >= options.maxRedirects) {
      throw new FileProcessorError(
        'too_many_redirects',
        `File URL '${initialUrl}' exceeded the limit of ${options.maxRedirects} redirects.`,
      );
    }

    const location = response.headers.get('location');
    if (!location) {
      throw new FileProcessorError('fetch_failed', `Redirect from '${currentUrl}' is missing a Location header.`);
    }

    try {
      currentUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new FileProcessorError(
        'invalid_url',
        `Redirect Location '${location}' from '${currentUrl}' is not a valid URL.`,
      );
    }
  }
}

export async function fetchFileAsBase64(
  url: string,
  options: FetchFileOptions = {},
): Promise<{ fileData: string; mimeType: string | undefined; filename: string | undefined }> {
  const maxSize = options.maxSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowedProtocols = options.allowedProtocols ? new Set(options.allowedProtocols) : ALLOWED_PROTOCOLS;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { response, finalUrl } = await fetchWithSsrfGuard(url, {
      allowedProtocols,
      maxRedirects,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new FileProcessorError(
        'fetch_failed',
        `Failed to fetch file from '${finalUrl}': ${response.status} ${response.statusText}`,
      );
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > maxSize) {
      throw new FileProcessorError('file_too_large', `File at '${finalUrl}' exceeds maximum allowed size.`);
    }

    const contentType = response.headers.get('content-type') || undefined;
    if (
      options.allowedContentTypes &&
      contentType &&
      !options.allowedContentTypes.some((type) => contentType.includes(type))
    ) {
      throw new FileProcessorError('content_type_not_allowed', `File content type '${contentType}' is not allowed.`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxSize) {
      throw new FileProcessorError('file_too_large', `File at '${finalUrl}' exceeds maximum allowed size.`);
    }

    const mimeType = contentType?.split(';')[0].trim() ?? 'application/octet-stream';
    const contentDisposition = response.headers.get('content-disposition');
    const filename = extractFilename(finalUrl, contentDisposition) ?? 'file';

    return {
      fileData: `data:${mimeType};base64,${buffer.toString('base64')}`,
      mimeType,
      filename,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Default processor: forwards base64 `file` blocks unchanged.
 * Handles `{ type: 'file', file: { file_data: 'data:...;base64,...' } }`.
 */
export const base64FileForwarder: FileProcessor = {
  name: 'base64FileForwarder',
  canHandle(block: FileContentBlock): boolean {
    if (block.type !== 'file') return false;
    const file = isRecord(block.file) ? block.file : undefined;
    if (!file) return false;
    const fileData = String(file.file_data ?? '');
    return fileData.startsWith('data:') && fileData.includes(';base64,');
  },
  async process(block: FileContentBlock): Promise<FileContentBlock> {
    return block;
  },
};

/**
 * Default processor: downloads an http(s) `file_url` and converts it into a `file` block.
 * Handles `{ type: 'file_url', file_url: { url: 'https://...' } }`.
 */
export const httpFileUrlFetcher: FileProcessor = {
  name: 'httpFileUrlFetcher',
  canHandle(block: FileContentBlock): boolean {
    if (block.type !== 'file_url') return false;
    const fileUrl = isRecord(block.file_url) ? block.file_url : undefined;
    if (!fileUrl) return false;
    const url = String(fileUrl.url ?? '');
    return url.startsWith('http://') || url.startsWith('https://');
  },
  async process(block: FileContentBlock): Promise<FileContentBlock> {
    const fileUrl = isRecord(block.file_url) ? block.file_url : undefined;
    const url = String(fileUrl?.url ?? '');
    if (!url) {
      throw new FileProcessorError('missing_url', "file_url block requires a 'url' property.");
    }
    const { fileData, mimeType, filename } = await fetchFileAsBase64(url);
    return {
      type: 'file',
      file: {
        file_data: fileData,
        mime_type: mimeType,
        filename: filename || 'file',
      },
    };
  },
};

function decodeBase64DataUrl(url: string): { mimeType: string; buffer: Buffer } | undefined {
  const match = /^data:([^;]+);base64,([A-Za-z0-9+/]+=*)$/.exec(url);
  if (!match) return undefined;
  try {
    const buffer = Buffer.from(match[2], 'base64');
    return { mimeType: match[1].toLowerCase(), buffer };
  } catch {
    return undefined;
  }
}

function isPdfBuffer(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.toString('binary', 0, 4) === '%PDF';
}

function isPdfFileBlock(block: FileContentBlock): boolean {
  if (block.type !== 'file') return false;
  const file = isRecord(block.file) ? block.file : undefined;
  if (!file) return false;
  const fileData = String(file.file_data ?? '');
  if (!fileData.startsWith('data:')) return false;
  const mimeType = String(file.mime_type ?? '').toLowerCase();
  if (mimeType === 'application/pdf') return true;
  if (fileData.startsWith('data:application/pdf')) return true;
  const decoded = decodeBase64DataUrl(fileData);
  if (decoded && isPdfBuffer(decoded.buffer)) return true;
  return false;
}

function getPluginFromContext(context: FileProcessorContext): any | undefined {
  // @ts-expect-error app may not be typed on Context in test mocks.
  return context.ctx.app?.pm?.get?.('plugin-ai-api');
}

/**
 * Optional processor: converts a PDF `file` block into a series of `image_url`
 * blocks when `pdfRenderPagesAsImages` is enabled and a PdfToImageRenderer is
 * registered. When disabled, unavailable, or the block is not a PDF, the block
 * is forwarded unchanged.
 */
export const pdfFileProcessor: FileProcessor = {
  name: 'pdfFileProcessor',
  canHandle(block: FileContentBlock): boolean {
    return isPdfFileBlock(block);
  },
  async process(
    block: FileContentBlock,
    context: FileProcessorContext,
  ): Promise<FileContentBlock | FileContentBlock[]> {
    const config = await getAiApiConfig(context.ctx);
    if (!config?.pdfRenderPagesAsImages) {
      return block;
    }

    const plugin = getPluginFromContext(context);
    const renderer = plugin?.fileProcessorService?.getPdfRenderer?.();
    if (!renderer) {
      context.ctx.log?.warn?.(
        '[pdfFileProcessor] pdfRenderPagesAsImages is enabled but no PdfToImageRenderer is registered. ' +
          'Forwarding PDF as a file block.',
      );
      return block;
    }

    const file = isRecord(block.file) ? block.file : undefined;
    const fileData = String(file?.file_data ?? '');
    const decoded = decodeBase64DataUrl(fileData);
    if (!decoded) {
      return block;
    }

    const pages = await renderer.render(decoded.buffer);
    return pages.map((buffer) => ({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${buffer.toString('base64')}` },
    }));
  },
};
