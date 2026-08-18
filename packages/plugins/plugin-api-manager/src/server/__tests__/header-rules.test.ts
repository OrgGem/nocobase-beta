import { describe, expect, it } from 'vitest';
import { buildForwardHeaders } from '../services/header-rules';

describe('header-rules buildForwardHeaders', () => {
  it('strips hop-by-hop and sensitive headers', () => {
    const result = buildForwardHeaders({
      incoming: {
        host: 'proxy.local',
        connection: 'keep-alive',
        'content-length': '10',
        'transfer-encoding': 'chunked',
        authorization: 'Bearer secret',
        'x-api-key': 'apim_secret',
        cookie: 'session=abc',
        'set-cookie': 'a=b',
        'x-safe': '1',
      },
    });
    expect(result.host).toBeUndefined();
    expect(result.connection).toBeUndefined();
    expect(result['content-length']).toBeUndefined();
    expect(result['transfer-encoding']).toBeUndefined();
    expect(result.authorization).toBeUndefined();
    expect(result['x-api-key']).toBeUndefined();
    expect(result.cookie).toBeUndefined();
    expect(result['set-cookie']).toBeUndefined();
    expect(result['x-safe']).toBe('1');
  });

  it('applies the forwardHeaders allowlist', () => {
    const result = buildForwardHeaders({
      incoming: {
        'x-tenant': 'acme',
        'x-trace': 't-1',
        'x-other': 'nope',
      },
      forwardHeaders: ['X-Tenant', 'x-trace'],
    });
    expect(result['x-tenant']).toBe('acme');
    expect(result['x-trace']).toBe('t-1');
    expect(result['x-other']).toBeUndefined();
  });

  it('joins array header values', () => {
    const result = buildForwardHeaders({ incoming: { 'x-multi': ['a', 'b'] } });
    expect(result['x-multi']).toBe('a, b');
  });

  it('injects staticHeaders', () => {
    const result = buildForwardHeaders({
      incoming: { 'x-keep': '1' },
      staticHeaders: [
        { name: 'X-Partner-Id', value: 'acme' },
        { name: 'X-Empty', value: '' },
      ],
    });
    expect(result['x-partner-id']).toBe('acme');
    expect(result['x-empty']).toBe('');
    expect(result['x-keep']).toBe('1');
  });

  it('ignores malformed staticHeaders entries', () => {
    const result = buildForwardHeaders({
      incoming: {},
      staticHeaders: [{ name: '  ', value: 'skip' }, undefined as unknown as { name: string; value: string }],
    });
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('sets content-type when provided', () => {
    const result = buildForwardHeaders({
      incoming: { 'content-type': 'application/octet-stream' },
      contentType: 'application/json',
    });
    expect(result['content-type']).toBe('application/json');
  });

  it('preserves incoming content-type when no override given', () => {
    const result = buildForwardHeaders({ incoming: { 'content-type': 'application/xml' } });
    expect(result['content-type']).toBe('application/xml');
  });
});
