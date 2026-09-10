import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RegistryRequestError } from '../registry-client';
import {
  clearEcrAuthCacheForTests,
  EcrAuthProvider,
  type EcrAuthOptions,
  type EcrClientFactory,
  type EcrClientLike,
} from '../ecr-auth';

const TOKEN_A = 'QVdTOmZpcnN0LXRva2Vu';
const TOKEN_B = 'QVdTOmZyZXNoLXRva2Vu';

function authResponse(token: string, expiresAt?: Date) {
  return { authorizationData: [{ authorizationToken: token, expiresAt }] };
}

function farFuture(): Date {
  return new Date(Date.now() + 12 * 60 * 60_000);
}

interface MockSetup {
  send: ReturnType<typeof vi.fn>;
  configs: Array<{ region: string; credentials?: unknown }>;
}

function mockClient(handler: (sendIndex: number) => unknown): { createClient: EcrClientFactory; mock: MockSetup } {
  const mock: MockSetup = { send: vi.fn(), configs: [] };
  mock.send.mockImplementation(async () => handler(mock.send.mock.calls.length - 1));
  const createClient: EcrClientFactory = (config) => {
    mock.configs.push(config);
    return { send: mock.send } as EcrClientLike;
  };
  return { createClient, mock };
}

function provider(createClient: EcrClientFactory, overrides: Partial<Omit<EcrAuthOptions, 'createClient'>> = {}) {
  return new EcrAuthProvider({
    region: 'ap-southeast-1',
    registryHost: '123456789012.dkr.ecr.ap-southeast-1.amazonaws.com',
    createClient,
    ...overrides,
  });
}

describe('EcrAuthProvider', () => {
  beforeEach(() => {
    clearEcrAuthCacheForTests();
    vi.useRealTimers();
  });

  it('returns Basic <authorizationToken> using the base64 token directly', async () => {
    const { createClient } = mockClient(() => authResponse(TOKEN_A, farFuture()));
    await expect(provider(createClient).getAuthorizationHeader()).resolves.toBe(`Basic ${TOKEN_A}`);
  });

  it('caches the token so a second call does not invoke send again', async () => {
    const { createClient, mock } = mockClient(() => authResponse(TOKEN_A, farFuture()));
    const auth = provider(createClient);
    await auth.getAuthorizationHeader();
    await auth.getAuthorizationHeader();
    expect(mock.send).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the cached token is inside the 30-minute buffer', async () => {
    const { createClient, mock } = mockClient((index) =>
      index === 0 ? authResponse(TOKEN_A, new Date(Date.now() + 20 * 60_000)) : authResponse(TOKEN_B, farFuture()),
    );
    const auth = provider(createClient);
    await expect(auth.getAuthorizationHeader()).resolves.toBe(`Basic ${TOKEN_A}`);
    await expect(auth.getAuthorizationHeader()).resolves.toBe(`Basic ${TOKEN_B}`);
    expect(mock.send).toHaveBeenCalledTimes(2);
  });

  it('uses single-flight so concurrent callers share one send', async () => {
    const { createClient, mock } = mockClient(() => authResponse(TOKEN_A, farFuture()));
    const auth = provider(createClient);
    const results = await Promise.all(Array.from({ length: 5 }, () => auth.getAuthorizationHeader()));
    expect(results).toEqual(Array(5).fill(`Basic ${TOKEN_A}`));
    expect(mock.send).toHaveBeenCalledTimes(1);
  });

  it('forceRefresh invalidates the cache and fetches a new token', async () => {
    const { createClient, mock } = mockClient((index) =>
      index === 0 ? authResponse(TOKEN_A, farFuture()) : authResponse(TOKEN_B, farFuture()),
    );
    const auth = provider(createClient);
    await auth.getAuthorizationHeader();
    await auth.forceRefresh();
    await expect(auth.getAuthorizationHeader()).resolves.toBe(`Basic ${TOKEN_B}`);
    expect(mock.send).toHaveBeenCalledTimes(2);
  });

  it('passes static credentials to the client factory', async () => {
    const { createClient, mock } = mockClient(() => authResponse(TOKEN_A, farFuture()));
    const auth = provider(createClient, { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret' });
    await auth.getAuthorizationHeader();
    expect(mock.configs[0]).toMatchObject({
      region: 'ap-southeast-1',
      credentials: { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret' },
    });
  });

  it('leaves credentials undefined so the SDK default chain (EC2 instance role) is used', async () => {
    const { createClient, mock } = mockClient(() => authResponse(TOKEN_A, farFuture()));
    await provider(createClient).getAuthorizationHeader();
    expect(mock.configs[0].credentials).toBeUndefined();
  });

  it('wraps SDK failures in RegistryRequestError with the ECR_AUTH_FAILED code', async () => {
    const { createClient } = mockClient(() => {
      throw new Error('AccessDenied: not authorized to perform ecr:GetAuthorizationToken');
    });
    await expect(provider(createClient).getAuthorizationHeader()).rejects.toMatchObject({
      name: 'RegistryRequestError',
      status: 403,
      code: 'ECR_AUTH_FAILED',
    });
    await expect(provider(createClient).getAuthorizationHeader()).rejects.toBeInstanceOf(RegistryRequestError);
  });

  it('fails when GetAuthorizationToken returns no authorization token', async () => {
    const { createClient } = mockClient(() => ({ authorizationData: [] }));
    await expect(provider(createClient).getAuthorizationHeader()).rejects.toMatchObject({
      code: 'ECR_AUTH_FAILED',
      message: expect.stringContaining('no authorization token'),
    });
  });

  it('falls back to a 12-hour TTL when expiresAt is missing and still caches', async () => {
    const { createClient, mock } = mockClient(() => authResponse(TOKEN_A));
    const auth = provider(createClient);
    await expect(auth.getAuthorizationHeader()).resolves.toBe(`Basic ${TOKEN_A}`);
    await expect(auth.getAuthorizationHeader()).resolves.toBe(`Basic ${TOKEN_A}`);
    expect(mock.send).toHaveBeenCalledTimes(1);
  });

  it('validate() calls GetAuthorizationToken so a bad configuration surfaces in testConnection', async () => {
    const { createClient, mock } = mockClient(() => {
      throw new Error('InvalidAccessKeyId');
    });
    await expect(provider(createClient).validate()).rejects.toMatchObject({ code: 'ECR_AUTH_FAILED' });
    expect(mock.send).toHaveBeenCalledTimes(1);
  });

  it('keeps tokens separate per region and registry host', async () => {
    const { createClient, mock } = mockClient((index) =>
      index === 0 ? authResponse(TOKEN_A, farFuture()) : authResponse(TOKEN_B, farFuture()),
    );
    const first = new EcrAuthProvider({
      region: 'ap-southeast-1',
      registryHost: 'host-a.ecr.amazonaws.com',
      createClient,
    });
    const second = new EcrAuthProvider({
      region: 'us-east-1',
      registryHost: 'host-b.ecr.amazonaws.com',
      createClient,
    });
    await expect(first.getAuthorizationHeader()).resolves.toBe(`Basic ${TOKEN_A}`);
    await expect(second.getAuthorizationHeader()).resolves.toBe(`Basic ${TOKEN_B}`);
    await expect(first.getAuthorizationHeader()).resolves.toBe(`Basic ${TOKEN_A}`);
    expect(mock.send).toHaveBeenCalledTimes(2);
  });
});
