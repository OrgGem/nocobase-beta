import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../constants';
import { ApimError } from '../services/errors';
import { forwardRequest } from '../services/proxy-engine';
import { MockUpstream } from './helpers';

describe('proxy-engine forwardRequest', () => {
  const upstream = new MockUpstream();
  const savedWhitelist = process.env.SERVER_REQUEST_WHITELIST;

  beforeAll(async () => {
    await upstream.start();
  });

  afterAll(async () => {
    await upstream.stop();
  });

  afterEach(() => {
    if (savedWhitelist === undefined) {
      delete process.env.SERVER_REQUEST_WHITELIST;
    } else {
      process.env.SERVER_REQUEST_WHITELIST = savedWhitelist;
    }
    upstream.requests = [];
    upstream.flakyRemaining = 0;
  });

  it('forwards a request and returns status, headers and body', async () => {
    const body = Buffer.from('{"hello":"world"}');
    const result = await forwardRequest({
      url: `${upstream.baseUrl}/echo`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      timeoutMs: 5000,
      retryCount: 0,
      retryDelayMs: 0,
    });
    expect(result.status).toBe(200);
    expect(result.attempt).toBe(1);
    expect(result.body.equals(body)).toBe(true);
    expect(result.headers['content-type']).toBe('application/json');
    expect(upstream.lastRequest?.body.equals(body)).toBe(true);
  });

  it('retries on 500 and succeeds on a later attempt', async () => {
    upstream.flakyRemaining = 1;
    const result = await forwardRequest({
      url: `${upstream.baseUrl}/flaky`,
      method: 'POST',
      headers: {},
      body: Buffer.alloc(0),
      timeoutMs: 5000,
      retryCount: 2,
      retryDelayMs: 10,
    });
    expect(result.status).toBe(200);
    expect(result.attempt).toBe(2);
    expect(result.body.toString('utf8')).toBe('recovered');
    expect(upstream.requests).toHaveLength(2);
  });

  it('returns the last upstream status when retries are exhausted', async () => {
    const result = await forwardRequest({
      url: `${upstream.baseUrl}/status/500`,
      method: 'POST',
      headers: {},
      body: Buffer.alloc(0),
      timeoutMs: 5000,
      retryCount: 2,
      retryDelayMs: 10,
    });
    expect(result.status).toBe(500);
    expect(result.attempt).toBe(3);
    expect(upstream.requests).toHaveLength(3);
  });

  it('does not retry on 4xx', async () => {
    const result = await forwardRequest({
      url: `${upstream.baseUrl}/status/404`,
      method: 'POST',
      headers: {},
      body: Buffer.alloc(0),
      timeoutMs: 5000,
      retryCount: 2,
      retryDelayMs: 10,
    });
    expect(result.status).toBe(404);
    expect(result.attempt).toBe(1);
    expect(upstream.requests).toHaveLength(1);
  });

  it('maps timeouts to APIM_TIMEOUT (504)', async () => {
    try {
      await forwardRequest({
        url: `${upstream.baseUrl}/delay/1500`,
        method: 'POST',
        headers: {},
        body: Buffer.alloc(0),
        timeoutMs: 200,
        retryCount: 0,
        retryDelayMs: 0,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApimError);
      expect((error as ApimError).code).toBe(ERROR_CODES.TIMEOUT);
      expect((error as ApimError).httpStatus).toBe(504);
    }
  });

  it('maps connection errors to APIM_UPSTREAM_ERROR (502)', async () => {
    try {
      await forwardRequest({
        url: 'http://127.0.0.1:1/echo',
        method: 'POST',
        headers: {},
        body: Buffer.alloc(0),
        timeoutMs: 2000,
        retryCount: 0,
        retryDelayMs: 0,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApimError);
      expect((error as ApimError).code).toBe(ERROR_CODES.UPSTREAM_ERROR);
      expect((error as ApimError).httpStatus).toBe(502);
    }
  });

  it('honours SERVER_REQUEST_WHITELIST (SSRF guard)', async () => {
    process.env.SERVER_REQUEST_WHITELIST = 'only.example.com';
    try {
      await forwardRequest({
        url: `${upstream.baseUrl}/echo`,
        method: 'POST',
        headers: {},
        body: Buffer.alloc(0),
        timeoutMs: 5000,
        retryCount: 0,
        retryDelayMs: 0,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApimError);
      expect((error as ApimError).code).toBe(ERROR_CODES.UPSTREAM_ERROR);
      expect((error as Error).message).toContain('blocked');
    }
    expect(upstream.requests).toHaveLength(0);
  });
});
