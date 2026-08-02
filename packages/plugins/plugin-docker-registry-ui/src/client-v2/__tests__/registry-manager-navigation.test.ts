import { describe, expect, it } from 'vitest';
import { resolveRegistryManagerView } from '../pages/RegistryManagerPage';

describe('Docker Registry manager navigation', () => {
  it('switches between images, repository and tag views from the current URL', () => {
    expect(resolveRegistryManagerView('')).toEqual({ page: 'images' });
    expect(resolveRegistryManagerView('?name=demo%2Falpine')).toEqual({
      page: 'repository',
      repository: 'demo/alpine',
    });
    expect(resolveRegistryManagerView('?name=demo%2Falpine&tag=latest')).toEqual({
      page: 'image',
      repository: 'demo/alpine',
      tag: 'latest',
    });
  });
});
