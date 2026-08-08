import { describe, expect, it } from 'vitest';

import { normalizeOperation } from '../route-normalizer';

describe('normalizeOperation', () => {
  it('prefers resolved NocoBase resource actions', () => {
    expect(normalizeOperation({ resourceName: 'users', actionName: 'get' }, '/api/users:get/42')).toBe('users:get');
  });

  // The middleware runs before `resourcer`, so ctx.action is still undefined and
  // the resource/action pair has to come from the path itself.
  it('resolves resource actions from the path when ctx.action is unavailable', () => {
    expect(normalizeOperation(undefined, '/api/users:list')).toBe('users:list');
    expect(normalizeOperation(undefined, '/api/users:get/42')).toBe('users:get');
    expect(normalizeOperation(undefined, '/api/users:list?page=1')).toBe('users:list');
    expect(normalizeOperation(undefined, '/api/appObservability:overview')).toBe('appObservability:overview');
  });

  it('keeps the association prefix for nested resources', () => {
    expect(normalizeOperation(undefined, '/api/users/1/orders:list')).toBe('users.orders:list');
  });

  it('normalizes numeric, uuid and long opaque path segments', () => {
    expect(normalizeOperation(undefined, '/api/users/123/orders/550e8400-e29b-41d4-a716-446655440000')).toBe(
      '/api/users/:id/orders/:id',
    );
    expect(normalizeOperation(undefined, '/files/01J4Z1N6G8V5F4Q8P2C3D7E9AB')).toBe('/files/:id');
  });
});
