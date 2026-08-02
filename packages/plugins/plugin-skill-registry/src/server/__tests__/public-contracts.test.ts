import { EventEmitter } from 'events';
import { Readable } from 'stream';

import { createHealthActions, createPublicActions } from '../actions';
import { RegistryError } from '../contracts/errors';
import { createPublicRateLimitMiddleware } from '../middlewares/public-rate-limit';
import type { RegistryModel } from '../services/model-values';
import { decodePublicCursor, encodePublicCursor, type PublicCursorScope } from '../services/public-cursor';
import { PublicRateLimitExceededError, type PublicRateLimiter } from '../services/public-rate-limiter';
import type { RegistryDatabase, RegistryRepository } from '../services/repository-types';

function model(values: Record<string, unknown>): RegistryModel {
  return { get: (attribute: string) => values[attribute] };
}

describe('skill registry public contracts', () => {
  const originalCursorSecret = process.env.SKILL_REGISTRY_CURSOR_SECRET;
  const originalPublicEnabled = process.env.SKILL_REGISTRY_PUBLIC_ENABLED;

  afterEach(() => {
    if (originalCursorSecret === undefined) {
      delete process.env.SKILL_REGISTRY_CURSOR_SECRET;
    } else {
      process.env.SKILL_REGISTRY_CURSOR_SECRET = originalCursorSecret;
    }
    if (originalPublicEnabled === undefined) {
      delete process.env.SKILL_REGISTRY_PUBLIC_ENABLED;
    } else {
      process.env.SKILL_REGISTRY_PUBLIC_ENABLED = originalPublicEnabled;
    }
  });

  it('accepts only signed, query-scoped keyset cursors', () => {
    process.env.SKILL_REGISTRY_CURSOR_SECRET = 'cursor-test-secret';
    const scope: PublicCursorScope = {
      endpoint: 'catalog',
      query: { q: null, tag: 'pdf', runtime: 'python', channel: 'stable' },
    };
    const anchor = { publishedAt: '2026-07-28T12:00:00.000Z', id: 'package-24' };
    const cursor = encodePublicCursor(scope, anchor);

    expect(decodePublicCursor(cursor, scope)).toEqual(anchor);
    let error: unknown;
    try {
      decodePublicCursor(`${cursor.slice(0, -1)}x`, scope);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RegistryError);
    expect(error).toMatchObject({
      code: 'INVALID_CURSOR',
      status: 400,
    });

    expect(() =>
      decodePublicCursor(cursor, {
        ...scope,
        query: { ...scope.query, channel: 'beta' },
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR', status: 400 }));
  });

  it('rejects malformed or excessive public page limits instead of silently changing them', async () => {
    const list = vi.fn();
    const actions = createPublicActions({
      database: { getRepository: vi.fn() } as never,
      catalog: { list } as never,
      artifactStore: {} as never,
      rateLimiter: () => undefined,
      signatureService: { keyId: 'unconfigured', publicKeyRing: () => ({}) } as never,
    });

    for (const limit of ['0', '101', '1.5', '20items', 0, 101]) {
      const ctx = {
        action: { params: { limit } },
        get: vi.fn().mockReturnValue(''),
        set: vi.fn(),
        state: {},
      };
      await expect(actions.list(ctx as never, async () => undefined)).rejects.toMatchObject({
        code: 'INVALID_LIMIT',
        status: 400,
      });
    }

    expect(list).not.toHaveBeenCalled();
  });

  it('bounds and validates every anonymous catalog filter before database work', async () => {
    const list = vi.fn();
    const actions = createPublicActions({
      database: { getRepository: vi.fn() } as never,
      catalog: { list } as never,
      artifactStore: {} as never,
      rateLimiter: () => undefined,
      signatureService: { keyId: 'unconfigured', publicKeyRing: () => ({}) } as never,
    });
    const invalidFilters = [
      { q: 'q'.repeat(201) },
      { tag: 't'.repeat(81) },
      { channel: 'c'.repeat(21) },
      { runtime: 'ruby' },
      { runtime: ['python'] },
    ];

    for (const query of invalidFilters) {
      const ctx = {
        action: { params: query },
        get: vi.fn().mockReturnValue(''),
        set: vi.fn(),
        state: {},
      };
      await expect(actions.list(ctx as never, async () => undefined)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        status: 400,
      });
    }

    expect(list).not.toHaveBeenCalled();
  });

  it('omits compatibility only when includeCompatibility is explicitly false', async () => {
    const row = {
      name: 'acme/report',
      displayName: 'Report',
      description: 'Creates reports.',
      tags: [],
      latest: { version: '1.0.0', channel: 'stable', artifactDigest: 'sha256:digest' },
      compatibility: { nocobase: '>=2.0.0' },
      downloads: 3,
    };
    const actions = createPublicActions({
      database: { getRepository: vi.fn() } as never,
      catalog: { list: vi.fn().mockResolvedValue({ rows: [row], nextAnchor: null }) } as never,
      artifactStore: {} as never,
      rateLimiter: () => undefined,
      signatureService: { keyId: 'unconfigured', publicKeyRing: () => ({}) } as never,
    });
    const context = (includeCompatibility?: unknown) => ({
      action: { params: includeCompatibility === undefined ? {} : { includeCompatibility } },
      body: undefined as unknown,
      status: 200,
      get: vi.fn().mockReturnValue(''),
      set: vi.fn(),
      state: {},
    });

    const defaultResponse = context();
    await actions.list(defaultResponse as never, async () => undefined);
    expect(defaultResponse.body).toMatchObject({ rows: [{ compatibility: { nocobase: '>=2.0.0' } }] });

    const compactResponse = context('false');
    await actions.list(compactResponse as never, async () => undefined);
    expect(compactResponse.body).toMatchObject({ rows: [{ name: 'acme/report', downloads: 3 }] });
    expect((compactResponse.body as { rows: Array<Record<string, unknown>> }).rows[0]).not.toHaveProperty(
      'compatibility',
    );

    await expect(actions.list(context('0') as never, async () => undefined)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      status: 400,
    });
  });

  it('rejects malformed package and version identities before catalog lookup with stable public errors', async () => {
    const getPackage = vi.fn();
    const resolveVersion = vi.fn();
    const actions = createPublicActions({
      database: { getRepository: vi.fn() } as never,
      catalog: { getPackage, resolveVersion } as never,
      artifactStore: {} as never,
      rateLimiter: () => undefined,
      signatureService: { keyId: 'unconfigured', publicKeyRing: () => ({}) } as never,
    });
    const context = (query: Record<string, unknown>) => ({
      action: { params: query },
      get: vi.fn().mockReturnValue(''),
      set: vi.fn(),
      state: {},
    });

    await expect(
      actions.get(context({ package: 'not-a-package' }) as never, async () => undefined),
    ).rejects.toMatchObject({ code: 'PACKAGE_NOT_FOUND', status: 404 });
    await expect(
      actions.download(context({ package: 'acme/report', version: 'not-semver' }) as never, async () => undefined),
    ).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND', status: 404 });
    await expect(
      actions.download(context({ package: 'acme/report', version: 100 }) as never, async () => undefined),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 });

    expect(getPackage).not.toHaveBeenCalled();
    expect(resolveVersion).not.toHaveBeenCalled();
  });

  it('accepts multi-value weak If-None-Match consistently for catalog responses', async () => {
    const packageRecord = model({
      id: 'package-1',
      namespace: 'acme',
      slug: 'report',
      displayName: 'Report',
      description: '',
      tags: [],
    });
    const catalog = {
      list: vi.fn().mockResolvedValue({ rows: [], nextAnchor: null }),
      getPackage: vi.fn().mockResolvedValue(packageRecord),
      findLatestVersion: vi.fn().mockResolvedValue(null),
      listVersions: vi.fn().mockResolvedValue({ rows: [], nextAnchor: null }),
    };
    const actions = createPublicActions({
      database: { getRepository: vi.fn() } as never,
      catalog: catalog as never,
      artifactStore: {} as never,
      rateLimiter: () => undefined,
      signatureService: { keyId: 'unconfigured', publicKeyRing: () => ({}) } as never,
    });
    const context = (query: Record<string, unknown>, ifNoneMatch = '') => {
      const headers = new Map<string, string>();
      return {
        action: { params: query },
        body: undefined as unknown,
        status: 200,
        get: vi.fn((name: string) => (name === 'if-none-match' ? ifNoneMatch : '')),
        set: (name: string, value: string) => headers.set(name, value),
        state: {},
        headers,
      };
    };

    const firstList = context({});
    await actions.list(firstList as never, async () => undefined);
    const listTag = firstList.headers.get('ETag');
    expect(listTag).toBeDefined();
    const cachedList = context({}, `"unrelated", W/${listTag}`);
    await actions.list(cachedList as never, async () => undefined);
    expect(cachedList).toMatchObject({ status: 304, body: null });

    const firstGet = context({ package: 'acme/report' });
    await actions.get(firstGet as never, async () => undefined);
    const getTag = firstGet.headers.get('ETag');
    expect(getTag).toBeDefined();
    const cachedGet = context({ package: 'acme/report' }, `"unrelated", W/${getTag}`);
    await actions.get(cachedGet as never, async () => undefined);
    expect(cachedGet).toMatchObject({ status: 304, body: null });

    const firstVersions = context({ package: 'acme/report' });
    await actions.versions(firstVersions as never, async () => undefined);
    const versionsTag = firstVersions.headers.get('ETag');
    expect(versionsTag).toBeDefined();
    const cachedVersions = context({ package: 'acme/report' }, `"unrelated", W/${versionsTag}`);
    await actions.versions(cachedVersions as never, async () => undefined);
    expect(cachedVersions).toMatchObject({ status: 304, body: null });
  });

  it('keeps package detail metadata bounded and leaves the full manifest in the artifact', async () => {
    const packageRecord = model({
      id: 'package-1',
      namespace: 'acme',
      slug: 'report',
      displayName: 'Report',
      description: 'Creates reports.',
      tags: [],
    });
    const latestVersion = model({
      version: '1.0.0',
      channel: 'stable',
      runtime: 'node',
      entrypoint: 'index.js',
      manifest: { inputSchema: { description: 'x'.repeat(1_000_000) } },
      manifestDigest: `sha256:${'c'.repeat(64)}`,
      artifactDigest: `sha256:${'d'.repeat(64)}`,
      publishedAt: new Date('2026-07-28T12:00:00.000Z'),
    });
    const actions = createPublicActions({
      database: { getRepository: vi.fn() } as never,
      catalog: {
        getPackage: vi.fn().mockResolvedValue(packageRecord),
        findLatestVersion: vi.fn().mockResolvedValue(latestVersion),
      } as never,
      artifactStore: {} as never,
      rateLimiter: () => undefined,
      signatureService: { keyId: 'unconfigured', publicKeyRing: () => ({}) } as never,
    });
    const ctx = {
      action: { params: { package: 'acme/report' } },
      body: undefined as unknown,
      get: vi.fn().mockReturnValue(''),
      set: vi.fn(),
      state: {},
    };

    await actions.get(ctx as never, async () => undefined);

    expect(ctx.body).toMatchObject({
      name: 'acme/report',
      latest: {
        version: '1.0.0',
        manifestDigest: `sha256:${'c'.repeat(64)}`,
        artifactDigest: `sha256:${'d'.repeat(64)}`,
      },
    });
    expect((ctx.body as { latest: Record<string, unknown> }).latest).not.toHaveProperty('manifest');
  });

  it('passes a scoped keyset anchor to the next catalog page', async () => {
    process.env.SKILL_REGISTRY_CURSOR_SECRET = 'cursor-test-secret';
    const anchor = { publishedAt: '2026-07-28T12:00:00.000Z', id: 'package-2' };
    const list = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ name: 'acme/one' }], nextAnchor: anchor })
      .mockResolvedValueOnce({ rows: [{ name: 'acme/two' }], nextAnchor: null });
    const actions = createPublicActions({
      database: { getRepository: vi.fn() } as never,
      catalog: { list } as never,
      artifactStore: {} as never,
      rateLimiter: () => undefined,
      signatureService: { keyId: 'unconfigured', publicKeyRing: () => ({}) } as never,
    });
    const context = (params: Record<string, unknown>) => ({
      action: { params },
      body: null as unknown,
      get: vi.fn().mockReturnValue(''),
      set: vi.fn(),
      state: {},
    });
    const first = context({ q: 'report', channel: 'stable', limit: '1' });

    await actions.list(first as never, async () => undefined);

    const firstBody = first.body as { nextCursor: string };
    const second = context({ q: 'report', channel: 'stable', limit: '1', cursor: firstBody.nextCursor });
    await actions.list(second as never, async () => undefined);

    expect(list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ limit: 1, after: anchor, q: 'report', channel: 'stable' }),
    );

    const reusedForDifferentQuery = context({
      q: 'different',
      channel: 'stable',
      limit: '1',
      cursor: firstBody.nextCursor,
    });
    await expect(actions.list(reusedForDifferentQuery as never, async () => undefined)).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
      status: 400,
    });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('blocks public reads when the opt-in flag is unset before the limiter or action', async () => {
    delete process.env.SKILL_REGISTRY_PUBLIC_ENABLED;
    const getLimiter = vi.fn(() => undefined);
    const middleware = createPublicRateLimitMiddleware(getLimiter);
    const next = vi.fn(async () => undefined);
    const ctx = {
      action: { resourceName: 'skillRegistryPublic', actionName: 'list' },
    };

    await expect(middleware(ctx as never, next)).rejects.toMatchObject({
      code: 'PUBLIC_REGISTRY_DISABLED',
      status: 503,
      message: 'Public registry endpoints are disabled.',
    });

    expect(getLimiter).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('stops public reads when the opt-in flag is explicitly false', async () => {
    process.env.SKILL_REGISTRY_PUBLIC_ENABLED = 'false';
    const getLimiter = vi.fn(() => undefined);
    const middleware = createPublicRateLimitMiddleware(getLimiter);
    const next = vi.fn(async () => undefined);
    const ctx = {
      action: { resourceName: 'skillRegistryPublic', actionName: 'list' },
    };

    await expect(middleware(ctx as never, next)).rejects.toMatchObject({
      code: 'PUBLIC_REGISTRY_DISABLED',
      status: 503,
      message: 'Public registry endpoints are disabled.',
    });

    expect(getLimiter).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('returns a stable public error without leaking an unexpected exception message', async () => {
    process.env.SKILL_REGISTRY_PUBLIC_ENABLED = 'true';
    const middleware = createPublicRateLimitMiddleware(() => {
      return {
        enforce: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED redis://private-cache:6379')),
      } as unknown as PublicRateLimiter;
    });
    const ctx = {
      action: { resourceName: 'skillRegistryPublic', actionName: 'list' },
      req: { socket: { remoteAddress: '198.51.100.10' } },
      get: vi.fn().mockReturnValue(''),
      set: vi.fn(),
      state: {} as Record<string, unknown>,
    };

    await expect(middleware(ctx as never, async () => undefined)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 500,
      message: 'An internal Skill Registry error occurred.',
    });
  });

  it('runs the limiter and public action when the opt-in flag is exactly true', async () => {
    process.env.SKILL_REGISTRY_PUBLIC_ENABLED = 'true';
    const enforce = vi.fn().mockResolvedValue({ limit: 20, remaining: 19, resetSeconds: 5 });
    const limiter = { enforce } as unknown as PublicRateLimiter;
    const getLimiter = vi.fn(() => limiter);
    const middleware = createPublicRateLimitMiddleware(getLimiter);
    const next = vi.fn(async () => undefined);
    const headers = new Map<string, string>();
    const ctx = {
      action: { resourceName: 'skillRegistryPublic', actionName: 'list' },
      req: { socket: { remoteAddress: '198.51.100.10' } },
      get: vi.fn().mockReturnValue(''),
      set(name: string, value: string) {
        headers.set(name, value);
      },
      state: {} as Record<string, unknown>,
      throw(status: number, message: string) {
        throw new Error(`${status}: ${message}`);
      },
    };

    await middleware(ctx as never, next);

    expect(getLimiter).toHaveBeenCalledTimes(1);
    expect(enforce).toHaveBeenCalledWith('catalog', '198.51.100.10');
    expect(next).toHaveBeenCalledTimes(1);
    expect(headers).toEqual(
      new Map([
        ['RateLimit-Limit', '20'],
        ['RateLimit-Remaining', '19'],
        ['RateLimit-Reset', '5'],
      ]),
    );
  });

  it('uses the limiter window that caused 429 for retry headers', async () => {
    process.env.SKILL_REGISTRY_PUBLIC_ENABLED = 'true';
    const enforce = vi
      .fn()
      .mockRejectedValue(new PublicRateLimitExceededError({ limit: 30, remaining: 0, resetSeconds: 527 }));
    const middleware = createPublicRateLimitMiddleware(() => ({ enforce }) as unknown as PublicRateLimiter);
    const next = vi.fn(async () => undefined);
    const headers = new Map<string, string>();
    const ctx = {
      action: { resourceName: 'skillRegistryPublic', actionName: 'download' },
      req: { socket: { remoteAddress: '198.51.100.10' } },
      get: vi.fn().mockReturnValue(''),
      set(name: string, value: string) {
        headers.set(name, value);
      },
      state: {} as Record<string, unknown>,
    };

    await expect(middleware(ctx as never, next)).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });

    expect(next).not.toHaveBeenCalled();
    expect(headers).toEqual(
      new Map([
        ['Retry-After', '527'],
        ['RateLimit-Limit', '30'],
        ['RateLimit-Remaining', '0'],
        ['RateLimit-Reset', '527'],
      ]),
    );
  });

  it('requires revalidation and records a download only after a GET response finishes', async () => {
    const rawDigest = 'a'.repeat(64);
    const digest = `sha256:${rawDigest}`;
    const storageKey = `sha256/aa/aa/${rawDigest}.zip`;
    const manifestDigest = `sha256:${'c'.repeat(64)}`;
    const artifact = model({
      id: 'artifact-1',
      verificationStatus: 'verified',
      digest,
      manifestDigest,
      storageDriver: 'filesystem',
      storageKey,
      format: 'zip',
      contentType: 'application/zip',
      sizeBytes: 9,
    });
    const packageRecord = model({ id: 'package-1', downloadCount: 0 });
    const version = model({
      id: 'version-1',
      version: '1.0.0',
      artifactId: 'artifact-1',
      artifactDigest: digest,
      manifestDigest,
    });
    const createDownload = vi.fn().mockResolvedValue(model({ id: 'download-1' }));
    const downloads = { create: createDownload } as unknown as RegistryRepository;
    const artifacts = { findOne: vi.fn().mockResolvedValue(artifact) } as unknown as RegistryRepository;
    const increment = vi.fn().mockResolvedValue(undefined);
    const database: RegistryDatabase = {
      getRepository(name: string): RegistryRepository {
        return (
          { skillRegistryDownloads: downloads, skillRegistryArtifacts: artifacts }[name] || ({} as RegistryRepository)
        );
      },
      getModel: () => ({ increment }),
    };
    const catalog = {
      resolveVersion: vi.fn().mockResolvedValue({ packageRecord, versionRecord: version }),
    };
    const headers = new Map<string, string>();
    const response = new EventEmitter();
    const artifactStream = Readable.from([Buffer.alloc(9)]);
    const openVerified = vi.fn().mockResolvedValue({ stream: artifactStream, sizeBytes: 9 });
    const release = vi.fn().mockResolvedValue(undefined);
    const acquireDownloadLease = vi.fn().mockResolvedValue({ responseTimeoutMs: 300_000, release });
    const ctx = {
      action: { params: { package: 'acme/report' } },
      method: 'GET',
      res: response,
      body: undefined as unknown,
      withoutDataWrapping: false,
      get: vi.fn((name: string) => (name === 'user-agent' ? 'registry-client/1.0' : '')),
      set: (name: string, value: string) => headers.set(name, value),
      state: { skillRegistryClientIp: '198.51.100.1' },
    };
    const actions = createPublicActions({
      database,
      catalog: catalog as never,
      artifactStore: {
        keyForDigest: vi.fn().mockReturnValue(storageKey),
        isKeyForDigest: vi.fn().mockReturnValue(true),
        openVerified,
      } as never,
      rateLimiter: () => ({ hashIp: vi.fn().mockReturnValue('hashed'), acquireDownloadLease }) as never,
      signatureService: { keyId: 'unconfigured', publicKeyRing: () => ({}) } as never,
    });

    await actions.download(ctx as never, async () => undefined);

    expect(headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(acquireDownloadLease).toHaveBeenCalledWith('198.51.100.1');
    expect(openVerified).toHaveBeenCalledWith(storageKey, digest, 9);
    expect(headers.get('Content-Length')).toBe('9');
    expect(ctx.body).toBe(artifactStream);
    expect(ctx.withoutDataWrapping).toBe(true);
    expect(createDownload).not.toHaveBeenCalled();
    expect(increment).not.toHaveBeenCalled();

    response.emit('finish');
    await vi.waitFor(() => {
      expect(createDownload).toHaveBeenCalledOnce();
      expect(increment).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    });

    response.emit('finish');
    expect(createDownload).toHaveBeenCalledOnce();
    expect(increment).toHaveBeenCalledOnce();
  });

  it('does not quarantine a valid artifact when storage is temporarily unavailable', async () => {
    const rawDigest = 'e'.repeat(64);
    const digest = `sha256:${rawDigest}`;
    const storageKey = `sha256/ee/ee/${rawDigest}.zip`;
    const manifestDigest = `sha256:${'f'.repeat(64)}`;
    const artifact = model({
      id: 'artifact-1',
      verificationStatus: 'verified',
      digest,
      manifestDigest,
      storageDriver: 'filesystem',
      storageKey,
      format: 'zip',
      contentType: 'application/zip',
      sizeBytes: 9,
    });
    const packageRecord = model({ id: 'package-1' });
    const version = model({
      id: 'version-1',
      version: '1.0.0',
      artifactId: 'artifact-1',
      artifactDigest: digest,
      manifestDigest,
    });
    const updateArtifact = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    const database: RegistryDatabase = {
      getRepository(name: string): RegistryRepository {
        if (name === 'skillRegistryArtifacts') {
          return {
            findOne: vi.fn().mockResolvedValue(artifact),
            update: updateArtifact,
          } as unknown as RegistryRepository;
        }
        return {} as RegistryRepository;
      },
      getModel: () => ({ increment: vi.fn() }),
    };
    const actions = createPublicActions({
      database,
      catalog: { resolveVersion: vi.fn().mockResolvedValue({ packageRecord, versionRecord: version }) } as never,
      artifactStore: {
        keyForDigest: vi.fn().mockReturnValue(storageKey),
        isKeyForDigest: vi.fn().mockReturnValue(true),
        openVerified: vi
          .fn()
          .mockRejectedValue(new RegistryError('ARTIFACT_STORAGE_UNAVAILABLE', 503, 'temporary storage outage')),
      } as never,
      rateLimiter: () =>
        ({
          hashIp: vi.fn().mockReturnValue('hashed'),
          acquireDownloadLease: vi.fn().mockResolvedValue({ responseTimeoutMs: 300_000, release }),
        }) as never,
      signatureService: { keyId: 'unconfigured', publicKeyRing: () => ({}) } as never,
    });
    const ctx = {
      action: { params: { package: 'acme/report', version: '1.0.0', channel: 'stable' } },
      method: 'GET',
      body: undefined as unknown,
      get: vi.fn().mockReturnValue(''),
      set: vi.fn(),
      state: { skillRegistryClientIp: '198.51.100.1' },
    };

    await expect(actions.download(ctx as never, async () => undefined)).rejects.toMatchObject({
      code: 'ARTIFACT_STORAGE_UNAVAILABLE',
      status: 503,
    });
    expect(updateArtifact).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('returns a conditional GET as 304 without opening, auditing, or counting the artifact', async () => {
    const rawDigest = 'b'.repeat(64);
    const digest = `sha256:${rawDigest}`;
    const storageKey = `sha256/bb/bb/${rawDigest}.zip`;
    const manifestDigest = `sha256:${'d'.repeat(64)}`;
    const artifact = model({
      id: 'artifact-1',
      verificationStatus: 'verified',
      digest,
      manifestDigest,
      storageDriver: 'filesystem',
      storageKey,
      format: 'zip',
      contentType: 'application/zip',
      sizeBytes: 9,
    });
    const packageRecord = model({ id: 'package-1' });
    const version = model({
      id: 'version-1',
      version: '1.0.0',
      artifactId: 'artifact-1',
      artifactDigest: digest,
      manifestDigest,
    });
    const createDownload = vi.fn().mockResolvedValue(model({ id: 'download-1' }));
    const increment = vi.fn().mockResolvedValue(undefined);
    const database: RegistryDatabase = {
      getRepository(name: string): RegistryRepository {
        if (name === 'skillRegistryArtifacts') {
          return { findOne: vi.fn().mockResolvedValue(artifact) } as unknown as RegistryRepository;
        }
        if (name === 'skillRegistryDownloads') {
          return { create: createDownload } as unknown as RegistryRepository;
        }
        return {} as RegistryRepository;
      },
      getModel: () => ({ increment }),
    };
    const response = new EventEmitter();
    const openVerified = vi.fn();
    const acquireDownloadLease = vi.fn();
    const ctx = {
      action: { params: { package: 'acme/report' } },
      method: 'GET',
      res: response,
      status: 200,
      body: undefined as unknown,
      get: vi.fn((name: string) => (name === 'if-none-match' ? `W/"sha256-${rawDigest}"` : '')),
      set: vi.fn(),
      state: { skillRegistryClientIp: '198.51.100.1' },
    };
    const actions = createPublicActions({
      database,
      catalog: { resolveVersion: vi.fn().mockResolvedValue({ packageRecord, versionRecord: version }) } as never,
      artifactStore: {
        keyForDigest: vi.fn().mockReturnValue(storageKey),
        isKeyForDigest: vi.fn().mockReturnValue(true),
        openVerified,
      } as never,
      rateLimiter: () => ({ hashIp: vi.fn().mockReturnValue('hashed'), acquireDownloadLease }) as never,
      signatureService: { keyId: 'unconfigured', publicKeyRing: () => ({}) } as never,
    });

    await actions.download(ctx as never, async () => undefined);

    expect(ctx.status).toBe(304);
    expect(ctx.body).toBeNull();
    expect(openVerified).not.toHaveBeenCalled();
    expect(acquireDownloadLease).not.toHaveBeenCalled();
    expect(response.listenerCount('finish')).toBe(0);
    expect(createDownload).not.toHaveBeenCalled();
    expect(increment).not.toHaveBeenCalled();
  });

  it('exposes readiness only as a status report and returns 503 while unready', async () => {
    const readiness = { check: vi.fn().mockResolvedValue({ ready: false, status: 'unready', checks: {} }) };
    const actions = createHealthActions(readiness as never);
    const ctx = { status: 0, body: null };

    await actions.readiness(ctx as never, async () => undefined);

    expect(ctx.status).toBe(503);
    expect(ctx.body).toEqual({ ready: false, status: 'unready', checks: {} });
  });
});
