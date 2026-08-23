import * as http from 'node:http';
import * as https from 'node:https';
import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import { URL } from 'node:url';
import { MANIFEST_ACCEPT, MODERN_MANIFEST_ACCEPT } from '../../shared/media-types';
import type {
  Descriptor,
  NormalizedManifest,
  RegistryConnection,
  RegistryDeleteImpact,
  RegistryListResult,
  RegistryRepositoryDeleteImpact,
  RegistryRepositoryDeleteResult,
  RegistryTagSummary,
} from '../../shared/types';
import { mergeImageConfig, normalizeManifest } from './manifest-normalizer';

interface RegistryResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  url: URL;
}

export interface RegistryBlobStream {
  status: number;
  headers: Record<string, string>;
  stream: http.IncomingMessage;
  url: URL;
}

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

export class RegistryRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'RegistryRequestError';
  }
}

const tokenCache = new Map<string, TokenCacheEntry>();
const MAX_TOKEN_CACHE_ENTRIES = 500;
const MAX_REDIRECTS = 5;
const MAX_SEARCH_PAGES = 1000;

function encodeRepository(repository: string): string {
  return repository.split('/').map(encodeURIComponent).join('/');
}

function setTokenCacheEntry(key: string, entry: TokenCacheEntry, now: number): void {
  while (tokenCache.size >= MAX_TOKEN_CACHE_ENTRIES) {
    let oldestKey = '';
    let oldestExpiresAt = Number.POSITIVE_INFINITY;
    for (const [candidateKey, candidate] of tokenCache) {
      if (candidate.expiresAt < oldestExpiresAt) {
        oldestKey = candidateKey;
        oldestExpiresAt = candidate.expiresAt;
      }
    }
    if (!oldestKey) {
      tokenCache.clear();
      break;
    }
    tokenCache.delete(oldestKey);
  }
  if (entry.expiresAt <= now) return;
  tokenCache.set(key, entry);
}

function toHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value.join(', ') : value ?? '',
    ]),
  );
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new RegistryRequestError('Registry returned invalid JSON');
  }
}

function registryError(response: RegistryResponse): RegistryRequestError {
  let code: string | undefined;
  let message = `Registry request failed with HTTP ${response.status}`;
  try {
    const payload = parseJson(response.body);
    if (typeof payload === 'object' && payload !== null && Array.isArray((payload as { errors?: unknown }).errors)) {
      const first = (payload as { errors: Array<{ code?: unknown; message?: unknown }> }).errors[0];
      if (typeof first?.code === 'string') code = first.code;
      if (typeof first?.message === 'string') message = first.message;
    }
  } catch {
    // Preserve the HTTP status when the registry did not return an error envelope.
  }
  return new RegistryRequestError(message, response.status, code);
}

function parseBearerChallenge(header: string | undefined): Record<string, string> | undefined {
  if (!header || !header.toLowerCase().startsWith('bearer ')) return undefined;
  const parameters: Record<string, string> = {};
  const expression = /([a-z_]+)="([^"]*)"/gi;
  for (const match of header.slice(7).matchAll(expression)) {
    parameters[match[1].toLowerCase()] = match[2];
  }
  return parameters.realm ? parameters : undefined;
}

function nextCursor(link: string | undefined): string | undefined {
  if (!link) return undefined;
  const next = link.split(',').find((part) => /rel="?next"?/i.test(part));
  const match = next?.match(/<([^>]+)>/);
  if (!match) return undefined;
  try {
    return new URL(match[1]).searchParams.get('last') ?? undefined;
  } catch {
    return undefined;
  }
}

function searchOffset(cursor: string | undefined): number {
  if (!cursor?.startsWith('search:')) return 0;
  const parsed = Number(cursor.slice('search:'.length));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function mapWithConcurrency<T, R>(values: T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return output;
}

export class RegistryClient {
  constructor(private readonly settings: RegistryConnection) {}

  private registryUrl(path: string): URL {
    if (!this.settings.registryUrl) throw new RegistryRequestError('Registry URL is not configured');
    return new URL(path.replace(/^\//, ''), `${this.settings.registryUrl.replace(/\/$/, '')}/`);
  }

  private async send(
    url: URL,
    method: string,
    headers: Record<string, string> = {},
    redirectCount = 0,
    body?: Buffer,
  ): Promise<RegistryResponse> {
    const transport = url.protocol === 'https:' ? https : http;
    const requestHeaders = { ...headers };
    const options: https.RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      method,
      path: `${url.pathname}${url.search}`,
      headers: requestHeaders,
      timeout: this.settings.requestTimeoutMs,
    };
    const registryOrigin = this.settings.registryUrl ? new URL(this.settings.registryUrl).origin : undefined;
    if (url.protocol === 'https:' && url.origin === registryOrigin) {
      options.rejectUnauthorized = this.settings.verifyTls;
      if (this.settings.caCertificate) options.ca = this.settings.caCertificate;
      if (this.settings.clientCertificate) options.cert = this.settings.clientCertificate;
      if (this.settings.clientPrivateKey) options.key = this.settings.clientPrivateKey;
      if (this.settings.clientPrivateKeyPassphrase) options.passphrase = this.settings.clientPrivateKeyPassphrase;
    }
    return new Promise((resolve, reject) => {
      const request = transport.request(options, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const responseHeaders = toHeaders(response.headers);
          const status = response.statusCode ?? 0;
          const location = responseHeaders.location;
          if ([301, 302, 303, 307, 308].includes(status) && location) {
            if (redirectCount >= MAX_REDIRECTS) {
              reject(
                new RegistryRequestError(
                  `Registry redirect limit of ${MAX_REDIRECTS} was exceeded`,
                  502,
                  'TOO_MANY_REDIRECTS',
                ),
              );
              return;
            }
            const target = new URL(location, url);
            const redirectedHeaders = { ...requestHeaders };
            if (target.origin !== url.origin) delete redirectedHeaders.authorization;
            const redirectedMethod = status === 303 && method !== 'HEAD' ? 'GET' : method;
            resolve(this.send(target, redirectedMethod, redirectedHeaders, redirectCount + 1, body));
            return;
          }
          resolve({
            status,
            headers: responseHeaders,
            body: Buffer.concat(chunks),
            url,
          });
        });
      });
      request.on('timeout', () =>
        request.destroy(new Error(`Registry request timed out after ${this.settings.requestTimeoutMs}ms`)),
      );
      request.on('error', (error) => reject(new RegistryRequestError(error.message)));
      request.end(body);
    });
  }

  private async sendStreaming(
    url: URL,
    method = 'GET',
    headers: Record<string, string> = {},
    redirectCount = 0,
  ): Promise<RegistryBlobStream> {
    const transport = url.protocol === 'https:' ? https : http;
    const options: https.RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      method,
      path: `${url.pathname}${url.search}`,
      headers,
      timeout: this.settings.requestTimeoutMs,
    };
    const registryOrigin = this.settings.registryUrl ? new URL(this.settings.registryUrl).origin : undefined;
    if (url.protocol === 'https:' && url.origin === registryOrigin) {
      options.rejectUnauthorized = this.settings.verifyTls;
      if (this.settings.caCertificate) options.ca = this.settings.caCertificate;
      if (this.settings.clientCertificate) options.cert = this.settings.clientCertificate;
      if (this.settings.clientPrivateKey) options.key = this.settings.clientPrivateKey;
      if (this.settings.clientPrivateKeyPassphrase) options.passphrase = this.settings.clientPrivateKeyPassphrase;
    }
    return new Promise((resolve, reject) => {
      const request = transport.request(options, (response) => {
        const responseHeaders = toHeaders(response.headers);
        const status = response.statusCode ?? 0;
        const location = responseHeaders.location;
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          if (redirectCount >= MAX_REDIRECTS) {
            response.resume();
            reject(
              new RegistryRequestError(
                `Registry redirect limit of ${MAX_REDIRECTS} was exceeded`,
                502,
                'TOO_MANY_REDIRECTS',
              ),
            );
            return;
          }
          const target = new URL(location, url);
          const redirectedHeaders = { ...headers };
          if (target.origin !== url.origin) delete redirectedHeaders.authorization;
          const redirectedMethod = status === 303 && method !== 'HEAD' ? 'GET' : method;
          response.resume();
          response.once('end', async () => {
            try {
              resolve(await this.sendStreaming(target, redirectedMethod, redirectedHeaders, redirectCount + 1));
            } catch (error) {
              reject(error);
            }
          });
          return;
        }
        resolve({ status, headers: responseHeaders, stream: response, url });
      });
      request.on('timeout', () =>
        request.destroy(new Error(`Registry request timed out after ${this.settings.requestTimeoutMs}ms`)),
      );
      request.on('error', (error) => reject(new RegistryRequestError(error.message)));
      request.end();
    });
  }

  private authorizationHeader(): string | undefined {
    if (this.settings.credentialMode === 'bearer' && this.settings.bearerToken) {
      return `Bearer ${this.settings.bearerToken}`;
    }
    if (this.settings.credentialMode === 'basic' && this.settings.username && this.settings.password) {
      return `Basic ${Buffer.from(`${this.settings.username}:${this.settings.password}`).toString('base64')}`;
    }
    return undefined;
  }

  private async bearerToken(challenge: Record<string, string>): Promise<string | undefined> {
    const scope = challenge.scope ?? '';
    const registryOrigin = this.settings.registryUrl ? new URL(this.settings.registryUrl).origin : '';
    const cacheKey = `${registryOrigin}|${challenge.realm}|${challenge.service ?? ''}|${scope}|${
      this.settings.username
    }`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 15000) return cached.token;
    const endpoint = new URL(challenge.realm);
    if (challenge.service) endpoint.searchParams.set('service', challenge.service);
    if (scope) endpoint.searchParams.set('scope', scope);
    const headers: Record<string, string> = {};
    if (this.settings.username && this.settings.password) {
      headers.authorization = `Basic ${Buffer.from(`${this.settings.username}:${this.settings.password}`).toString(
        'base64',
      )}`;
    }
    const response = await this.send(endpoint, 'GET', headers);
    if (response.status < 200 || response.status >= 300) return undefined;
    const payload = parseJson(response.body);
    if (typeof payload !== 'object' || payload === null) return undefined;
    const token =
      (payload as { token?: unknown; access_token?: unknown }).token ??
      (payload as { token?: unknown; access_token?: unknown }).access_token;
    if (typeof token !== 'string' || !token) return undefined;
    const expiresIn = Number((payload as { expires_in?: unknown }).expires_in ?? 60);
    const now = Date.now();
    setTokenCacheEntry(cacheKey, { token, expiresAt: now + Math.max(60, expiresIn) * 1000 }, now);
    return token;
  }

  private async requestUrl(
    url: URL,
    method = 'GET',
    headers: Record<string, string> = {},
    body?: Buffer,
  ): Promise<RegistryResponse> {
    const withAuth = { ...headers };
    const authorization = this.authorizationHeader();
    if (authorization) withAuth.authorization = authorization;
    const response = await this.send(url, method, withAuth, 0, body);
    const challenge = parseBearerChallenge(response.headers['www-authenticate']);
    if (response.status !== 401 || !challenge || this.settings.credentialMode === 'bearer') return response;
    const token = await this.bearerToken(challenge);
    if (!token) return response;
    return this.send(url, method, { ...headers, authorization: `Bearer ${token}` }, 0, body);
  }

  private async request(
    path: string,
    method = 'GET',
    headers: Record<string, string> = {},
    body?: Buffer,
  ): Promise<RegistryResponse> {
    return this.requestUrl(this.registryUrl(path), method, headers, body);
  }

  private async requestStreaming(path: string): Promise<RegistryBlobStream> {
    const url = this.registryUrl(path);
    const headers: Record<string, string> = {};
    const authorization = this.authorizationHeader();
    if (authorization) headers.authorization = authorization;
    let response = await this.sendStreaming(url, 'GET', headers);
    const challenge = parseBearerChallenge(response.headers['www-authenticate']);
    if (response.status !== 401 || !challenge || this.settings.credentialMode === 'bearer') return response;
    const drained = once(response.stream, 'end');
    response.stream.resume();
    await drained;
    const token = await this.bearerToken(challenge);
    if (!token) return response;
    response = await this.sendStreaming(url, 'GET', { authorization: `Bearer ${token}` });
    return response;
  }

  private manifestAccept(): string {
    return this.settings.showLegacySchema1 ? MANIFEST_ACCEPT : MODERN_MANIFEST_ACCEPT;
  }

  async health(): Promise<{
    reachable: boolean;
    authentication: 'public' | 'required' | 'failed';
    apiVersion?: string;
  }> {
    const response = await this.request('v2/');
    if (response.status >= 200 && response.status < 300) {
      return {
        reachable: true,
        authentication: 'public',
        apiVersion: response.headers['docker-distribution-api-version'],
      };
    }
    if (response.status === 401) {
      return {
        reachable: true,
        authentication: this.authorizationHeader() ? 'failed' : 'required',
        apiVersion: response.headers['docker-distribution-api-version'],
      };
    }
    return {
      reachable: false,
      authentication: 'failed',
      apiVersion: response.headers['docker-distribution-api-version'],
    };
  }

  private async listRepositoriesPage(last?: string): Promise<RegistryListResult> {
    const query = new URLSearchParams({ n: String(this.settings.catalogPageSize) });
    if (last) query.set('last', last);
    const response = await this.request(`v2/_catalog?${query.toString()}`);
    if (response.status < 200 || response.status >= 300) throw registryError(response);
    const payload = parseJson(response.body);
    const repositories =
      typeof payload === 'object' &&
      payload !== null &&
      Array.isArray((payload as { repositories?: unknown }).repositories)
        ? (payload as { repositories: unknown[] }).repositories.filter(
            (name): name is string => typeof name === 'string',
          )
        : [];
    return { items: repositories, nextCursor: nextCursor(response.headers.link) };
  }

  private async listTagsPage(repository: string, last?: string): Promise<RegistryListResult> {
    const query = new URLSearchParams({ n: String(this.settings.catalogPageSize) });
    if (last) query.set('last', last);
    const response = await this.request(`v2/${encodeRepository(repository)}/tags/list?${query.toString()}`);
    if (response.status < 200 || response.status >= 300) throw registryError(response);
    const payload = parseJson(response.body);
    const tags =
      typeof payload === 'object' && payload !== null && Array.isArray((payload as { tags?: unknown }).tags)
        ? (payload as { tags: unknown[] }).tags.filter((tag): tag is string => typeof tag === 'string')
        : [];
    return { items: tags, nextCursor: nextCursor(response.headers.link) };
  }

  private async collectAll(fetchPage: (cursor?: string) => Promise<RegistryListResult>): Promise<string[]> {
    const items: string[] = [];
    const seenItems = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
      const result = await fetchPage(cursor);
      for (const item of result.items) {
        if (!seenItems.has(item)) {
          seenItems.add(item);
          items.push(item);
        }
      }
      if (!result.nextCursor || seenCursors.has(result.nextCursor)) return items;
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new RegistryRequestError(
      `Registry search exceeded ${MAX_SEARCH_PAGES} catalog pages`,
      422,
      'SEARCH_PAGE_LIMIT',
    );
  }

  private async filteredPage(
    search: string,
    cursor: string | undefined,
    fetchPage: (cursor?: string) => Promise<RegistryListResult>,
  ): Promise<RegistryListResult> {
    const normalizedSearch = search.trim().toLowerCase();
    if (!normalizedSearch) return fetchPage(cursor);
    const matches = (await this.collectAll(fetchPage)).filter((item) => item.toLowerCase().includes(normalizedSearch));
    const offset = searchOffset(cursor);
    const items = matches.slice(offset, offset + this.settings.catalogPageSize);
    const nextOffset = offset + items.length;
    return {
      items,
      nextCursor: nextOffset < matches.length ? `search:${nextOffset}` : undefined,
    };
  }

  async listRepositories(last?: string, search = ''): Promise<RegistryListResult> {
    return this.filteredPage(search, last, (cursor) => this.listRepositoriesPage(cursor));
  }

  async listTags(repository: string, last?: string, search = ''): Promise<RegistryListResult> {
    return this.filteredPage(search, last, (cursor) => this.listTagsPage(repository, cursor));
  }

  private async getManifest(
    repository: string,
    reference: string,
    includeReferrers: boolean,
  ): Promise<NormalizedManifest> {
    const response = await this.request(
      `v2/${encodeRepository(repository)}/manifests/${encodeURIComponent(reference)}`,
      'GET',
      {
        accept: this.manifestAccept(),
      },
    );
    if (response.status < 200 || response.status >= 300) throw registryError(response);
    const digest = response.headers['docker-content-digest'] ?? reference;
    let manifest = normalizeManifest(parseJson(response.body), response.headers['content-type'], digest);
    if (manifest.kind === 'legacy' && !this.settings.showLegacySchema1) {
      throw new RegistryRequestError(
        'Legacy Docker Schema 1 manifests are disabled in Docker Registry settings',
        415,
        'LEGACY_SCHEMA_DISABLED',
      );
    }
    if (manifest.kind === 'image' && manifest.config?.digest) {
      const configResponse = await this.request(
        `v2/${encodeRepository(repository)}/blobs/${encodeURIComponent(manifest.config.digest)}`,
      );
      if (configResponse.status >= 200 && configResponse.status < 300) {
        manifest = mergeImageConfig(manifest, parseJson(configResponse.body));
      }
    }
    if (includeReferrers && digest.startsWith('sha256:')) {
      const referrers = await this.getReferrers(repository, digest);
      manifest = { ...manifest, ...referrers };
    }
    return manifest;
  }

  async getImageDetails(repository: string, reference: string): Promise<NormalizedManifest> {
    return this.getManifest(repository, reference, true);
  }

  async getManifestDocument(
    repository: string,
    reference: string,
  ): Promise<{ digest: string; mediaType: string; body: Buffer }> {
    const response = await this.request(
      `v2/${encodeRepository(repository)}/manifests/${encodeURIComponent(reference)}`,
      'GET',
      { accept: this.manifestAccept() },
    );
    if (response.status < 200 || response.status >= 300) throw registryError(response);
    return {
      digest: response.headers['docker-content-digest'] ?? reference,
      mediaType: response.headers['content-type']?.split(';', 1)[0] ?? 'application/vnd.oci.image.manifest.v1+json',
      body: response.body,
    };
  }

  async openBlob(repository: string, digest: string): Promise<RegistryBlobStream> {
    const response = await this.requestStreaming(
      `v2/${encodeRepository(repository)}/blobs/${encodeURIComponent(digest)}`,
    );
    if (response.status < 200 || response.status >= 300) {
      response.stream.resume();
      throw new RegistryRequestError(`Unable to download blob ${digest}`, response.status, 'BLOB_DOWNLOAD_FAILED');
    }
    return response;
  }

  async uploadBlob(
    repository: string,
    digest: string,
    filePath: string,
    size: number,
    chunkSize: number,
  ): Promise<'uploaded' | 'reused'> {
    const existing = await this.request(
      `v2/${encodeRepository(repository)}/blobs/${encodeURIComponent(digest)}`,
      'HEAD',
    );
    if (existing.status >= 200 && existing.status < 300) return 'reused';
    const start = await this.request(
      `v2/${encodeRepository(repository)}/blobs/uploads/`,
      'POST',
      { 'content-length': '0' },
      Buffer.alloc(0),
    );
    if (start.status < 200 || start.status >= 300 || !start.headers.location) throw registryError(start);
    let location = new URL(start.headers.location, this.registryUrl(''));
    let offset = 0;
    const stream = createReadStream(filePath, { highWaterMark: chunkSize });
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk as Uint8Array);
      const response = await this.requestUrl(
        location,
        'PATCH',
        {
          'content-type': 'application/octet-stream',
          'content-length': String(buffer.length),
          'content-range': `${offset}-${offset + buffer.length - 1}`,
        },
        buffer,
      );
      if (response.status < 200 || response.status >= 300) throw registryError(response);
      if (response.headers.location) location = new URL(response.headers.location, location);
      offset += buffer.length;
    }
    if (offset !== size)
      throw new RegistryRequestError(`Blob size changed while uploading ${digest}`, 409, 'BLOB_SIZE_CHANGED');
    const finalUrl = new URL(location);
    finalUrl.searchParams.set('digest', digest);
    const completed = await this.requestUrl(finalUrl, 'PUT', { 'content-length': '0' }, Buffer.alloc(0));
    if (completed.status < 200 || completed.status >= 300) throw registryError(completed);
    return 'uploaded';
  }

  async putManifest(repository: string, reference: string, body: Buffer, mediaType: string): Promise<string> {
    const response = await this.request(
      `v2/${encodeRepository(repository)}/manifests/${encodeURIComponent(reference)}`,
      'PUT',
      { 'content-type': mediaType, 'content-length': String(body.length) },
      body,
    );
    if (response.status < 200 || response.status >= 300) throw registryError(response);
    return response.headers['docker-content-digest'] ?? reference;
  }

  async getReferrers(
    repository: string,
    digest: string,
  ): Promise<{ referrers: Descriptor[]; referrersSupported: boolean }> {
    const response = await this.request(
      `v2/${encodeRepository(repository)}/referrers/${encodeURIComponent(digest)}`,
      'GET',
      {
        accept: 'application/vnd.oci.image.index.v1+json',
      },
    );
    if (response.status === 404 || response.status === 405) return { referrers: [], referrersSupported: false };
    if (response.status < 200 || response.status >= 300) throw registryError(response);
    const normalized = normalizeManifest(parseJson(response.body), response.headers['content-type'], digest);
    return {
      referrers: normalized.kind === 'index' ? normalized.manifests : [],
      referrersSupported: true,
    };
  }

  async getTagSummaries(repository: string, tags: string[]): Promise<RegistryTagSummary[]> {
    return mapWithConcurrency(tags, this.settings.maxConcurrentRequests, async (tag) => {
      try {
        const manifest = await this.getManifest(repository, tag, false);
        return {
          tag,
          digest: manifest.digest,
          kind: manifest.kind,
          mediaType: manifest.mediaType,
          size:
            manifest.kind === 'image'
              ? manifest.size
              : manifest.kind === 'index'
                ? manifest.manifests.reduce((total, item) => total + (item.size ?? 0), 0)
                : undefined,
          layerCount: manifest.kind === 'image' ? manifest.layers.length : undefined,
          platformCount: manifest.kind === 'index' ? manifest.manifests.length : undefined,
          created: manifest.kind === 'image' ? manifest.created : undefined,
          architecture: manifest.kind === 'image' ? manifest.architecture : undefined,
          os: manifest.kind === 'image' ? manifest.os : undefined,
        } satisfies RegistryTagSummary;
      } catch (error) {
        return {
          tag,
          error: error instanceof Error ? error.message : 'Unable to inspect tag',
        } satisfies RegistryTagSummary;
      }
    });
  }

  async resolveManifestDigest(repository: string, reference: string): Promise<string> {
    const head = await this.request(
      `v2/${encodeRepository(repository)}/manifests/${encodeURIComponent(reference)}`,
      'HEAD',
      {
        accept: this.manifestAccept(),
      },
    );
    if (head.status < 200 || head.status >= 300) throw registryError(head);
    const digest = head.headers['docker-content-digest'];
    if (!digest) throw new RegistryRequestError('Registry did not return Docker-Content-Digest');
    return digest;
  }

  async getDeleteImpact(repository: string, tag: string): Promise<RegistryDeleteImpact> {
    const digest = await this.resolveManifestDigest(repository, tag);
    const tags = await this.collectAll((cursor) => this.listTagsPage(repository, cursor));
    const digests = await mapWithConcurrency(tags, this.settings.maxConcurrentRequests, async (candidate) => {
      try {
        return await this.resolveManifestDigest(repository, candidate);
      } catch {
        return undefined;
      }
    });
    return {
      digest,
      tags: tags.filter((_, index) => digests[index] === digest),
    };
  }

  async getRepositoryDeleteImpact(repository: string): Promise<RegistryRepositoryDeleteImpact> {
    const tags = await this.collectAll((cursor) => this.listTagsPage(repository, cursor));
    const resolved = await mapWithConcurrency(tags, this.settings.maxConcurrentRequests, async (tag) => {
      try {
        return { tag, digest: await this.resolveManifestDigest(repository, tag) };
      } catch {
        return { tag, digest: undefined };
      }
    });
    const manifestTags = new Map<string, string[]>();
    const unresolvedTags: string[] = [];
    for (const item of resolved) {
      if (!item.digest) {
        unresolvedTags.push(item.tag);
        continue;
      }
      manifestTags.set(item.digest, [...(manifestTags.get(item.digest) ?? []), item.tag]);
    }
    const manifests = [...manifestTags.entries()]
      .map(([digest, aliases]) => ({ digest, tags: aliases.sort() }))
      .sort((left, right) => left.digest.localeCompare(right.digest));
    return {
      repository,
      tags: [...tags].sort(),
      manifests,
      unresolvedTags: unresolvedTags.sort(),
      signature: manifests.map((item) => item.digest).join(','),
    };
  }

  async deleteTag(
    repository: string,
    tag: string,
    expectedDigest?: string,
    confirmSharedDigest = false,
  ): Promise<RegistryDeleteImpact> {
    const impact = await this.getDeleteImpact(repository, tag);
    if (expectedDigest && expectedDigest !== impact.digest) {
      throw new RegistryRequestError(
        'The tag digest changed after confirmation; reload and try again',
        409,
        'DIGEST_CHANGED',
      );
    }
    if (impact.tags.length > 1 && !confirmSharedDigest) {
      throw new RegistryRequestError(
        `This manifest is shared by tags: ${impact.tags.join(', ')}`,
        409,
        'SHARED_MANIFEST_CONFIRMATION_REQUIRED',
      );
    }
    const response = await this.request(
      `v2/${encodeRepository(repository)}/manifests/${encodeURIComponent(impact.digest)}`,
      'DELETE',
      {
        accept: this.manifestAccept(),
      },
    );
    if (response.status < 200 || response.status >= 300) throw registryError(response);
    return impact;
  }

  async deleteRepositoryContents(
    repository: string,
    expectedSignature?: string,
    confirmRepository = false,
  ): Promise<RegistryRepositoryDeleteResult> {
    if (!confirmRepository) {
      throw new RegistryRequestError(
        'Repository deletion requires explicit confirmation',
        409,
        'REPOSITORY_CONFIRMATION_REQUIRED',
      );
    }
    const impact = await this.getRepositoryDeleteImpact(repository);
    if (impact.unresolvedTags.length > 0) {
      throw new RegistryRequestError(
        `Unable to resolve tags: ${impact.unresolvedTags.join(', ')}`,
        409,
        'REPOSITORY_TAGS_UNRESOLVED',
      );
    }
    if (!impact.signature || impact.signature !== expectedSignature) {
      throw new RegistryRequestError(
        'Repository contents changed after confirmation; reload and try again',
        409,
        'REPOSITORY_CONTENTS_CHANGED',
      );
    }
    const deletedDigests: string[] = [];
    for (const manifest of impact.manifests) {
      const response = await this.request(
        `v2/${encodeRepository(repository)}/manifests/${encodeURIComponent(manifest.digest)}`,
        'DELETE',
        { accept: this.manifestAccept() },
      );
      if (response.status < 200 || response.status >= 300) throw registryError(response);
      deletedDigests.push(manifest.digest);
    }
    return { ...impact, deletedDigests };
  }
}
