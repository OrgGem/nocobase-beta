import { describe, expect, it } from 'vitest';

import { normalizeOperation } from '../route-normalizer';

describe('normalizeOperation', () => {
  it('prefers resolved NocoBase resource actions', () => {
    expect(normalizeOperation({ resourceName: 'users', actionName: 'get' }, '/api/users:get/42')).toBe('users:get');
  });

  it('normalizes numeric, uuid and long opaque path segments', () => {
    expect(normalizeOperation(undefined, '/api/users/123/orders/550e8400-e29b-41d4-a716-446655440000')).toBe(
      '/api/users/:id/orders/:id',
    );
    expect(normalizeOperation(undefined, '/files/01J4Z1N6G8V5F4Q8P2C3D7E9AB')).toBe('/files/:id');
  });
});
